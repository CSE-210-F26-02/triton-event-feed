import { AuthProvider } from "./auth/auth";

const auth = new AuthProvider();

// Testing notes:
// Don't host on Vite's default hostname (localhost), need to specify 127.0.0.1 to statisfy the atproto library

await auth.preInitClient();
const initOutcome = await auth.initClient();
if (initOutcome) {
    console.log("Successful login");
} else {
    auth.login("chherbert.bsky.social");
}

console.log("Session valid: " + auth.isSessionValid());