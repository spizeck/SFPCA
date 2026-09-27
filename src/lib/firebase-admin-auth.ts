import { getAuth } from "firebase-admin/auth";
import { getAdminApp } from "./firebase-admin-app";

// Auth is isolated in its own module: only callers that verify tokens or
// manage users import the firebase-admin/auth graph (jwks-rsa -> jose),
// the dependency chain behind the #144 Vercel ERR_REQUIRE_ESM outage.
export const adminAuth = () => getAuth(getAdminApp());
