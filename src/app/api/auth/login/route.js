import { getDb } from "../../../../lib/mongodb";
import { comparePassword, signToken } from "../../../../lib/auth";
import { cleanDoc, json, options } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
    return options(req);
}

export async function POST(req) {
    try {
        const { email, password } = await req.json();

        const normalizedEmail = String(email || "").toLowerCase().trim();
        const normalizedPassword = String(password || "");

        if (!normalizedEmail && !normalizedPassword) {
            return json({ message: "Email and password are required", field: "email_password" }, 400);
        }

        if (!normalizedEmail) {
            return json({ message: "Email is required", field: "email" }, 400);
        }

        if (!normalizedPassword) {
            return json({ message: "Password is required", field: "password" }, 400);
        }

        const db = await getDb();
        const users = db.collection(process.env.USER_COLLECTION || "userData");

        const user = await users.findOne({ email: normalizedEmail });
        if (!user) {
            return json({ message: "Email is incorrect", field: "email" }, 401);
        }

        let ok = false;
        if (user.passwordHash) {
            ok = await comparePassword(normalizedPassword, user.passwordHash);
        } else if (user.password) {
            // Backward compatibility for legacy plaintext records.
            ok = String(user.password) === normalizedPassword;
        }

        if (!ok) {
            return json({ message: "Password is incorrect", field: "password" }, 401);
        }

        if (user.status === "blocked") {
            return json({ message: "Account is blocked" }, 403);
        }

        const token = signToken({
            id: String(user._id),
            email: user.email,
            name: user.name,
            role: user.role,
        });

        const safeUser = { ...user };
        delete safeUser.passwordHash;

        return json({ token, user: cleanDoc(safeUser) });
    } catch (error) {
        return json({ message: "Login failed", error: error.message }, 500);
    }
}
