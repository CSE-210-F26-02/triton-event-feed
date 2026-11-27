// Useful Link: https://github.com/bluesky-social/cookbook/tree/main/vanillajs-oauth-web-app#readme
// Note privacy concerns with using BSky's handle resolver
// Ended up using https://github.com/bluesky-social/atproto/tree/main/packages/api for the hybrid password/oauth implementation

import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import { Agent, CredentialSession } from '@atproto/api';

// TODO: Warn users abot privacy policy, or deploy our own handler
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
     */
    #oAuthClient;

    /**
     * TODO: Uncertain if this should be kept, may remove later on.
     * An OAuthSession (from @atproto/oauth-client) object representing the user's current authenticated session.
     * May be null if session is invalid.
     */
    #oAuthSession;

    // Below are products of authentication, both password and OAuth will create these

    /**
     * An Agent object (from the atproto API) for interacting with the user's PDS. May be null if session is invalid.
     */
    #agent;

    constructor() {
        this.#clientID = buildClientID();
    }

    /**
     * Initializes the OAuth Client. Should be called exactly once before login if OAuth-based authentication is desired. (Not needed for password-based)
     * @returns True if the initialization successfully recovered an existing session, false otherwise (should call login to get a session if false)
     */
    async initClient() {
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

        const oAuthResult = await this.#oAuthClient.init();

        if (oAuthResult) {
            const {session, state } = oAuthResult;
            // Docs seem to indicate session will always exist
            this.#oAuthSession = session;
            this.#agent = new Agent(session);
            if (state != null) {
                console.log(`Sucessful authentication via redirect, state: ${state}`);
                return true;
            } else {
                console.log("Sucessful authentication from last active session");
                return true;
            }
        } else {
            console.log("Failed to authenticate, user needs to login");
            return false;
        }
    }

    /**
     * Unified function to log the user in, using either password or OAuth. 
     * If not in a local test environment, OAuth attempts to login silently. (TODO: test)
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

            this.#oAuthSession = await this.#oAuthClient.signIn(handle, {
                state: 'some value needed later',
                prompt: signInPrompt,
                ui_locales: 'en',
                signal: new AbortController().signal
            });

            // Unreachable, will redirect, prompting a page reload that restarts the client init process.
        } catch (err) {
            // Login aborted
            console.error(err);
        }
    }

    /**
     * Logs the user in, using a password. 
     * Initializes the agent field of the AuthProvider if successful.
     */
    async loginPassword(handle, password) {
        try {
            const session = new CredentialSession(new URL('https://bsky.social'));
            await session.login({
                identifier: handle,
                password: password,
            });
            this.#agent = new Agent(session);
        } catch (err) {
            console.error(err);
        }
    }

    invalidateSession() {
        // Handles session invalidation, may want to add a redirect at some point
        this.#oAuthSession = null;
        this.#agent = null;
    }

    isSessionValid() {
        return this.#oAuthClient !== null && this.#oAuthSession !== null && this.#agent !== null;
    }

    /**
     * Use this to manipulate user PDS data.
     */
    get agent() {
        return this.#agent;
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