import { AuthProvider } from "../auth";

// Just a quick demo of the auth provider.

// Testing notes:
// Don't host on Vite's default hostname (localhost), need to specify 127.0.0.1 to statisfy the atproto library's specifications
// For local testing, hosting the website with 'npx vite --host 127.0.0.1' and then navigating to the site (+port) has worked for me.

const auth = new AuthProvider();

function checkSession(){
    const validSession = auth.isSessionValid();

    console.log(`Session valid: ${validSession}`);
    if (validSession) {
        console.log(`Session: ${auth.agent.did}`);
    } 
}

const initOutcome = await auth.initClient();
if (initOutcome) {
    console.log("Successful login");
    checkSession();
}

document.getElementById("bsky-oauth-login").onclick = async (event) => {
    await auth.login(document.getElementById("user-handle").value);
    checkSession();
};

document.getElementById("password-login").onclick = async (event) => {
    await auth.login(document.getElementById("user-handle").value, document.getElementById("app-pw").value);
    checkSession();
};

