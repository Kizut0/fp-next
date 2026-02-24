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

        if (!email || !password) {
            return json({ message: "Email and password are required" }, 400);
        }

        const db = await getDb();
        const users = db.collection(process.env.USER_COLLECTION || "userData");
        const normalizedEmail = String(email).toLowerCase().trim();

        const user = await users.findOne({ email: normalizedEmail });
        if (!user) {
            return json({ message: "Invalid credentials" }, 401);
        }

        let ok = false;
        if (user.passwordHash) {
            ok = await comparePassword(password, user.passwordHash);
        } else if (user.password) {
            // Backward compatibility for legacy plaintext records.
            ok = String(user.password) === String(password);
        }

        if (!ok) {
            return json({ message: "Invalid credentials" }, 401);
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