import { getDb } from "../../../../lib/mongodb";
import { hashPassword, signToken } from "../../../../lib/auth";
import { cleanDoc, json, options } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
    return options(req);
}

export async function POST(req) {
    try {
        const { name, email, password, role } = await req.json();

        if (!name || !email || !password) {
            return json({ message: "Name, email and password are required" }, 400);
        }

        const requestedRole = String(role || "").trim().toLowerCase();
        if (requestedRole === "admin") {
            return json({ message: "Admin registration is not allowed" }, 403);
        }
        const safeRole = requestedRole === "client" ? "Client" : "Freelancer";

        const db = await getDb();
        const users = db.collection(process.env.USER_COLLECTION || "userData");
        const normalizedEmail = String(email).toLowerCase().trim();

        const existing = await users.findOne({ email: normalizedEmail });
        if (existing) {
            return json({ message: "Email already registered" }, 409);
        }

        const passwordHash = await hashPassword(password);
        const now = new Date();

        const insert = await users.insertOne({
            name: String(name).trim(),
            email: normalizedEmail,
            passwordHash,
            role: safeRole,
            status: "active",
            withdrawCount: 0,
            createdAt: now,
            updatedAt: now,
        });

        const user = await users.findOne({ _id: insert.insertedId }, { projection: { passwordHash: 0 } });

        const token = signToken({
            id: String(insert.insertedId),
            email: user.email,
            name: user.name,
            role: user.role,
        });

        return json({ token, user: cleanDoc(user) }, 201);
    } catch (error) {
        return json({ message: "Register failed", error: error.message }, 500);
    }
}
