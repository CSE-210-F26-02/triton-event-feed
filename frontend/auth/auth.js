// Useful Link: https://github.com/bluesky-social/cookbook/tree/main/vanillajs-oauth-web-app#readme
// Note privacy concerns with using BSky's handle resolver

import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
import { Agent } from '@atproto/api'

// TODO: Warn users abot privacy policy, or deploy our own handler
const HandleResolver = 'https://bsky.social';

class AuthProvider
{
    /**
     * A URL pointing to the client metadata document (oauth-client-metadata.json). Currently unused in local testing setup.
     */
    #clientID;

    /**
     * An OAuthClient object representing the provider's current interface with the OAuth api.
     */
    #oAuthClient;

    /**
     * An OAuthSession object representing the user's current authenticated session. May be null if session is invalid.
     */
    #oAuthSession;
    
    /**
     * An Agent object (from the atproto API) for interacting with the user's PDS. May be null if session is invalid.
     */
    #agent;

    constructor() {
        this.#clientID = buildClientID();
    }

    /**
     * Constructs the oAuth client used by this provider. Should be called exactly once. 
     */
    async preInitClient() {
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
    }

    /**
     * Initializes the oAuth Client after it has been constructed in preInit. Should be called exactly once.
     * @returns True if the initialization successfully recovered an existing session, false otherwise (should call login to get a session if false)
     */
    async initClient() {
        const result = await this.#oAuthClient.init();

        if (result) {
            const {session, state } = result;
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
     * Logs the user in using a fully specified handle. If not in a local test environment, attempts to login silently.
     */
    async login(handle) {
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

    invalidateSession() {
        // Handles session invalidation, may want to add a redirect at some point
        this.#oAuthSession = null;
        this.#agent = null;
    }

    isSessionValid() {
        return this.#oAuthClient !== null && this.#oAuthSession !== null && this.#agent !== null;
    }

    get oAuthClient() {
        return this.#oAuthClient;
    }

    get session() {
        return this.#oAuthSession;
    }

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
            redirect_uri: Object.assign(new URL(window.location.origin), { hostname: '127.0.0.1' }).href,
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