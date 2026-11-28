// Mostly follows https://github.com/bluesky-social/atproto/tree/main/packages/lex/lex
// Another helpful link: https://github.com/bluesky-social/cookbook/tree/main/vanillajs-oauth-web-app#readme
// Note privacy concerns with using BSky's handle resolver

import { BrowserOAuthClient, OAuthCallbackError } from '@atproto/oauth-client-browser';
import { OAuthResolverError, OAuthSession } from '@atproto/oauth-client';
import { PasswordSession } from '@atproto/lex-password-session';
import { Client, XrpcAuthenticationError } from '@atproto/lex-client';

// TODO: Warn users about privacy policy, or deploy our own handler
const HandleResolver = 'https://bsky.social';

class AuthProvider
{
    /**
     * A URL pointing to the client metadata document (oauth-client-metadata.json).
     */
    #clientID;

    // OAuth-specific data

    /**
     * An OAuthClient object representing the provider's current interface with the OAuth API.
     * Do not confuse with the PDS client, accessed through AuthProvider.client.
     */
    #oAuthClient;

    // Below are products of authentication, both password and OAuth will create these

    /**
     * An object representing the user's current authenticated session.
     * Can be either an OAuthSession (from atproto/oauth-client) or a PasswordSession (from atproto/lex-password-session).
     * In either case, the client field should be used for actual PDS manipulation.
     * May be null if session is invalid.
     */
    #session;

    /**
     * A Client object (from @atproto/lex) for interacting with the user's PDS. May be null if session is invalid.
     */
    #client;

    /**
     * Called when login attempt by handler fails.
     * Logs a message by default, assign to handler function if desired.
     */ 
    onFailedLogin = () => { console.log("Failed to login."); };

    /**
     * Called when an invalid handle or password is provided.
     * Logs a message by default, assign to handler function if desired.
     */
    onInvalidUserInfo = () => { console.log("Invalid user login information was provided, cannot login."); };

    /**
     * Called when a login attempt succeeds.
     * Logs a message by default, assign to handler function if desired.
     */
    onSuccessfulLogin = () => { console.log("User succesfully logged in."); };

    /**
     * Called when the user logs out.
     * Logs a message by default, assign to handler function if desired.
     */
    onLogout = () => { console.log("User has logged out."); };

    constructor() {
        this.#clientID = buildClientID();
    }

    /**
     * Attempts to resume a session if one already exists. Also handles failed OAuth logins
     * Starts by checking for password sessions.
     * Otherwise, initializes the OAuth Client, which may recover an OAuth session. 
     * Should be called exactly once before login if OAuth-based authentication is desired.
     * 
     * @returns True if the initialization successfully recovered an existing session, false otherwise (should call login to get a session if false)
     */
    async init() {
        // Apparently possible to avoid trip to fetch metadata document, see top link
        this.#oAuthClient = await BrowserOAuthClient.load({
            clientId: this.#clientID,
            handleResolver: HandleResolver,
        });

        // TODO: Handles session invalidation
        // Based on snippet from https://www.npmjs.com/package/@atproto/oauth-client-browser
        /* this.#oAuthClient.addEventListener('deleted', ( event ) => {
            this.invalidateSession();
            const { sub, cause } = event.detail;
            console.error(`Session for ${sub} is no longer available (cause: ${cause})`);
        });*/
        var oAuthResult;
        try {
            oAuthResult = await this.#oAuthClient.init();
        } catch(err) {
            if (err instanceof OAuthCallbackError) {
                // Failed oAuth login
                this.onFailedLogin();
            } else {
                throw err;
            }
        }

        if (oAuthResult) {
            const {session, state } = oAuthResult;
            // Docs seem to indicate session will always exist
            this.#session = session;
            this.#client = new Client(session);
            this.onSuccessfulLogin();

            if (state != null) {
                console.log(`Sucessful authentication via redirect, state: ${state}`);
                return true;
            } else {
                console.log("Sucessful authentication from last active session");
                return true;
            }
        } else {
            console.log("Failed to authenticate from existing session, user needs to login");
            return false;
        }
    }

    /**
     * Unified function to log the user in, using either password or OAuth. 
     * If a password is provided, attempts to use password authentication.
     */
    async login(handle, password=null) {
        if (password) {
            await this.loginPassword(handle, password);
        } else {
            await this.loginOAuth(handle);
        }
    }

    /**
     * Logs the user in, using OAuth. 
     * If not in a local test environment, OAuth attempts to login silently. (TODO: test)
     * Results in a redirect if successful, causing a page refresh
     */
    async loginOAuth(handle) {
        try {
            // Can only perform a silent sign on for non-local clients
            const signInPrompt = isLocal() ? 'login' : 'none';

            this.#session = await this.#oAuthClient.signIn(handle, {
                state: 'some value needed later',
                prompt: signInPrompt,
                ui_locales: 'en',
                signal: new AbortController().signal
            });

            // Unreachable, will redirect, prompting a page reload that restarts the client init process.
        } catch (err) {
            if (err instanceof OAuthResolverError) {
                this.onInvalidUserInfo();
            } else {
                console.error(err);
            }

            this.invalidateSession();
        }
    }

    /**
     * Logs the user in, using a password. 
     * Initializes the agent field of the AuthProvider if successful.
     */
    async loginPassword(handle, password) {
        // Based on https://github.com/bluesky-social/atproto/tree/main/packages/lex/lex#client-api
        try {
            this.#session = await PasswordSession.login({
                service: 'https://bsky.social', //TODO: If we use a custom PDS, change this.
                identifier: handle,
                password: password,
                onUpdated: (data) => {
                    // Persist session for later restoration
                    localStorage.setItem('session', JSON.stringify(data))
                },
                onDeleted: () => {
                    localStorage.removeItem('session')
                },
            });

            this.#client = new Client(this.#session);

            this.onSuccessfulLogin();
        } catch (err) {
            if (err instanceof XrpcAuthenticationError) {
                this.onInvalidUserInfo();
            } else {
                console.error(err);
            }

            this.invalidateSession();
        }
    }

    /**
     * Logs the user out of their current session. Calls invalidateSession to clean up AuthProvider properties.
     */
    async logout() {
        if (this.#session) {
            // Try password logout first, then OAuth revoke.
            if(this.#session instanceof PasswordSession){
                await this.#session.logout();
            } else if (this.#session instanceof OAuthSession) {
                await this.#session.signOut();
            }
        }
        this.invalidateSession();
        this.onLogout();
    }

    // Handles session invalidation, may want to add a redirect at some point
    invalidateSession() {
        this.#session = null;
        this.#client = null;
    }

    isSessionValid() {
        return this.#session !== null && this.#client !== null;
    }

    /**
     * Use this to manipulate user PDS data.
     */
    get client() {
        return this.#client;
    }
}

/**
 * Constructs a Client ID for an authorization request. Client IDs must be a web URL pointing to a client metadata JSON document.
 * See https://atproto.com/specs/oauth for more information.
 * @returns A URL (string) representing the Client ID for an authorization request.
 */
function buildClientID() {

    if (isLocal()) {
        return `http://localhost?${new URLSearchParams({
            // Specifies all permissions we may need from this authorization.
            scope: "atproto repo:app.bsky.feed.post?action=create",
            // Redirect URI for local developement must have a 127.0.0.1 hostname, per specs
            redirect_uri: Object.assign(new URL(window.location.origin), { hostname: '127.0.0.1', pathname: window.location.pathname }).href,
        })}`;
    }

    // TODO: update file, currently just an example copied from link
    // If not in a local developement environment, point to metadata file of page host (us)
    // Or, could even hardcode into program, per https://www.npmjs.com/package/@atproto/oauth-client-browser
    return `https://${window.location.host}/frontend/auth/oauth-client-metadata.json`;
}

function isLocal() {
    // Checks if current hostname is a synonym for the local host
    // Should only ever use 127.0.0.1, but localhost is included for completeness
    return ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

export { AuthProvider };