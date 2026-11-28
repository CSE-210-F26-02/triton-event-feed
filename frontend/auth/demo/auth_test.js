import { AuthProvider } from "../auth";

// Just a quick demo of the auth provider.

// Testing notes:
// Don't host on Vite's default hostname (localhost), need to specify 127.0.0.1 to statisfy the atproto library's specifications
// For local testing, hosting the website with 'npx vite --host 127.0.0.1' and then navigating to the site (+port) has worked for me.

const auth = new AuthProvider();

// Setup header toggles for when login fails. (typically when user cancels at OAuth screen)
auth.onFailedLogin = () => {
    document.getElementById("success-header").style.display = "none";
    document.getElementById("logout-header").style.display = "none";
    document.getElementById("invalid-user-header").style.display = "none";
    document.getElementById("fail-header").style.display = "inherit";
};

// Setup header toggles for when user information is invalid.
auth.onInvalidUserInfo = () => {
    document.getElementById("fail-header").style.display = "none";
    document.getElementById("success-header").style.display = "none";
    document.getElementById("logout-header").style.display = "none";
    document.getElementById("invalid-user-header").style.display = "inherit";
};

// Setup header toggles for when login is successful.
auth.onSuccessfulLogin = async () => {
    document.getElementById("fail-header").style.display = "none";
    document.getElementById("invalid-user-header").style.display = "none";
    document.getElementById("logout-header").style.display = "none";
    document.getElementById("success-header").style.display = "inherit";
};

// Setup header toggles for logout.
auth.onLogout = () => {
    document.getElementById("fail-header").style.display = "none";
    document.getElementById("invalid-user-header").style.display = "none";
    document.getElementById("success-header").style.display = "none";
    document.getElementById("logout-header").style.display = "inherit";
};


// Demo function
function checkSession(){
    const validSession = auth.isSessionValid();

    console.log(`Session valid: ${validSession}`);
    if (validSession) {
        console.log(`Session: ${auth.client.did}`);
    } 
}

// OAuth/Password flow
const initOutcome = await auth.init();
if (initOutcome) {
    console.log("Successful login");
    checkSession();
}

// Controls
document.getElementById("bsky-oauth-login").onclick = async (event) => {
    await auth.login(document.getElementById("user-handle").value);
    checkSession();
};

document.getElementById("password-login").onclick = async (event) => {
    await auth.login(document.getElementById("user-handle").value, document.getElementById("app-pw").value);
    checkSession();
};

document.getElementById("logout").onclick = async (event) => {
    await auth.logout();
    checkSession();
};

