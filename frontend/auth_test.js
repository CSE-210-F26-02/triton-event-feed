import { AuthProvider } from "./auth/auth";

// Just a quick demo of the auth provider.

// Testing notes:
// Don't host on Vite's default hostname (localhost), need to specify 127.0.0.1 to statisfy the atproto library's specifications
// For local testing, hosting the website with 'npx vite --host 127.0.0.1' and then navigating to the site (+port) has worked for me.

const auth = new AuthProvider();

await auth.preInitClient();
const initOutcome = await auth.initClient();
if (initOutcome) {
    console.log("Successful login");
} else {
    auth.login("chherbert.bsky.social");
}

const validSession = auth.isSessionValid()

console.log(`Session valid: ${validSession}`);
if (validSession) {
    console.log(`Session: ${auth.session.sub}`)
} 