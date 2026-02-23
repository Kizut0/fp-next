import { NextResponse } from "next/server";

function getAllowedOrigins() {
    const fromEnv = (process.env.CORS_ORIGIN || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

    const defaults = ["http://127.0.0.1:5173", "http://localhost:5173"];
    return [...new Set([...defaults, ...fromEnv])];
}

function buildCorsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
    };
}

export function middleware(req) {
    if (!req.nextUrl.pathname.startsWith("/api/")) {
        return NextResponse.next();
    }

    const requestOrigin = req.headers.get("origin") || "";
    const allowed = getAllowedOrigins();
    const origin = allowed.includes(requestOrigin) ? requestOrigin : allowed[0];
    const headers = buildCorsHeaders(origin);

    if (req.method === "OPTIONS") {
        return new NextResponse(null, { status: 204, headers });
    }

    const res = NextResponse.next();
    Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
    return res;
}

export const config = {
    matcher: ["/api/:path*"],
};