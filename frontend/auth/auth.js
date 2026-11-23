// Useful Link: https://github.com/bluesky-social/cookbook/tree/main/vanillajs-oauth-web-app#readme
// Note privacy concerns with using BSky's handle resolver

import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
// import { Agent } from '@atproto/api'

const HandleResolver = 'https://bsky.social'

class AuthHandler
{
    #clientID
    #OAClient
    #OACSession
    #agent

    constructor() {
        this.#clientID = buildClientID();
    }

    async preInitClient() {
        if (isLocal()) {
            // Loopback client as suggested by https://github.com/bluesky-social/atproto/tree/main/packages/oauth/oauth-client-browser
            this.#OAClient = new BrowserOAuthClient({
                handleResolver: HandleResolver,
                clientMetadata: undefined,
            })
        } else {
            this.#OAClient = await BrowserOAuthClient.load({
                // Apparently possible to avoid trip to fetch metadata document, see top link
                clientId: this.#clientID,
                handleResolver: HandleResolver,
            });
        }
    }

    async initClient() {
        const result = await this.#OAClient.init();

        if (result) {
            const {session, state } = result;
            // Docs seem to indicate session will always exist
            this.#OACSession = session;
            //this.#agent = Agent(session);
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

    async login(handle) {
        try {
            // Can only perform a silent sign on for non-local clients
            const signInPrompt = isLocal() ? 'login' : 'none'

            await this.#OAClient.signIn(handle, {
                state: 'some value needed later',
                prompt: signInPrompt,
                ui_locales: 'en',
                signal: new AbortController().signal
            });

            // Unreachable
        } catch (err) {
            // Login aborted
            console.error(err);
        }
    }

    get getOAuthClient() {
        return this.#OAClient;
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
    return ["localhost", "127.0.0.1"].includes(window.location.hostname)
}

export { AuthHandler };