import { getDb } from "../../../../lib/mongodb";
import { json, options } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });

    const usersCollection = process.env.USER_COLLECTION || "userData";
    const usersCount = await db.collection(usersCollection).countDocuments({});

    return json(
      {
        ok: true,
        database: process.env.MONGODB_DB || "web_project_2",
        usersCollection,
        usersCount,
      },
      200,
      req
    );
  } catch (error) {
    return json(
      {
        ok: false,
        message: "Database connection failed",
        error: error.message,
      },
      500,
      req
    );
  }
}
