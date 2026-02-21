import { MongoClient } from "mongodb";

const dbName = process.env.MONGODB_DB || "freelance_platform";

let cachedClient = global._mongoClient;
let cachedDb = global._mongoDb;

export async function getDb() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("Missing MONGODB_URI in environment variables");
    }

    if (!cachedClient) {
        cachedClient = new MongoClient(uri);
        global._mongoClient = cachedClient;
    }

    if (!cachedDb) {
        await cachedClient.connect();
        cachedDb = cachedClient.db(dbName);
        global._mongoDb = cachedDb;
    }
    return cachedDb;
}
