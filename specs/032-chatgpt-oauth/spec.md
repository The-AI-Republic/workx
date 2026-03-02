# Feature Specification: ChatGPT OAuth Subscription Authentication

**Feature Branch**: `032-chatgpt-oauth`
**Created**: 2026-02-24
**Status**: Draft
**Input**: User description: "implement the design browserx/.ai_design/chatgpt_oauth_design.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign in with ChatGPT on Desktop (Priority: P1)

A BrowserX desktop user who has a ChatGPT Plus or Pro subscription wants to use OpenAI models without obtaining a separate API key. They navigate to Settings, see a "Sign in with ChatGPT" button under the OpenAI provider section, click it, complete the authentication in their browser, and return to BrowserX where the connection status shows they are authenticated. They can immediately select an OpenAI model and start chatting.

**Why this priority**: This is the core value proposition — removing the friction of separate API key billing and enabling subscription-based access. Desktop is the primary platform.

**Independent Test**: Can be fully tested by clicking "Sign in with ChatGPT" in Settings, completing the browser-based login, and verifying that an OpenAI model can be used for a conversation without entering an API key.

**Acceptance Scenarios**:

1. **Given** a desktop user with no OpenAI API key configured, **When** they click "Sign in with ChatGPT" in Settings, **Then** a browser window opens to the ChatGPT login page
2. **Given** the user completes the ChatGPT login in the browser, **When** the browser redirects back, **Then** BrowserX shows "Connected via ChatGPT" status and the browser tab closes automatically
3. **Given** a user is connected via ChatGPT OAuth, **When** they select an OpenAI model and send a message, **Then** the model responds using their ChatGPT subscription (no API key required)
4. **Given** a user is connected via ChatGPT OAuth, **When** they restart BrowserX, **Then** they remain authenticated without needing to sign in again

---

### User Story 2 - Automatic Token Refresh (Priority: P1)

A user who signed in with ChatGPT continues to use BrowserX over an extended session. Their access token expires after approximately one hour, but BrowserX automatically refreshes it in the background before making API calls, so the user experiences no interruption.

**Why this priority**: Without automatic refresh, users would be forced to re-authenticate every hour, making the feature impractical for real use.

**Independent Test**: Can be tested by authenticating, waiting for the token to near expiry, and verifying that the next API call succeeds without user intervention.

**Acceptance Scenarios**:

1. **Given** a user's access token is expiring within 5 minutes, **When** they send a message, **Then** the system automatically refreshes the token before making the API call
2. **Given** a token refresh succeeds, **When** a new refresh token is returned, **Then** the new refresh token replaces the old one in secure storage
3. **Given** a token refresh fails due to revoked access, **When** the user tries to send a message, **Then** they see a clear message to re-sign in and the UI shows disconnected status

---

### User Story 3 - Switch Between API Key and ChatGPT OAuth (Priority: P2)

A user who is connected via ChatGPT OAuth decides to switch to using their own API key instead (or vice versa). The two authentication methods are mutually exclusive for the OpenAI provider — activating one automatically deactivates the other.

**Why this priority**: Users need a clear, conflict-free way to manage their OpenAI authentication method. Without this, credential conflicts could cause confusing errors.

**Independent Test**: Can be tested by connecting via OAuth, then entering an API key, and verifying the OAuth session is cleared (and vice versa).

**Acceptance Scenarios**:

1. **Given** a user is connected via ChatGPT OAuth, **When** they enter and save an API key for OpenAI, **Then** the ChatGPT OAuth session is disconnected and the API key becomes the active authentication method
2. **Given** a user has an API key configured, **When** they click "Sign in with ChatGPT" and complete the flow, **Then** the API key is no longer used and ChatGPT OAuth becomes the active method
3. **Given** a user is connected via ChatGPT OAuth, **When** they click "Disconnect", **Then** the OAuth tokens are cleared and the API key input becomes active again

---

### User Story 4 - Sign in with ChatGPT on Chrome Extension (Priority: P3)

A BrowserX Chrome extension user wants to use their ChatGPT subscription. They click "Sign in with ChatGPT" in the extension settings, a new browser tab opens for authentication, and upon completion the tab closes and the extension shows connected status.

**Why this priority**: Extension support extends the feature to the second platform, but desktop is the primary use case and this can follow after.

**Independent Test**: Can be tested by clicking "Sign in with ChatGPT" in the extension settings, completing login in the opened tab, and verifying the extension shows connected status and can use OpenAI models.

**Acceptance Scenarios**:

1. **Given** a Chrome extension user, **When** they click "Sign in with ChatGPT", **Then** a new browser tab opens to the ChatGPT login page
2. **Given** the user completes login in the tab, **When** the redirect occurs, **Then** the tab closes and the extension settings show "Connected via ChatGPT"
3. **Given** a connected extension user, **When** they send a message using an OpenAI model, **Then** the model responds using their ChatGPT subscription

---

### Edge Cases

- What happens when the local callback port (1455) is already in use by another application?
  - The system shows a clear error message asking the user to close the conflicting application and try again.
- What happens when the user closes the browser authentication tab before completing login?
  - The login flow times out after 5 minutes and the UI resets to the disconnected state with no error shown.
- What happens when the user's ChatGPT subscription expires or is downgraded?
  - API calls return rate limit or authorization errors from OpenAI, which are shown to the user. The OAuth connection itself remains active but usage is subject to subscription tier limits.
- What happens when two BrowserX instances try to authenticate simultaneously?
  - The second instance fails to bind the callback port and shows an error. Only one instance can authenticate at a time.
- What happens during a network outage while refreshing tokens?
  - The system retries on the next API call. If the refresh token is still valid, the next refresh attempt succeeds when connectivity is restored.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a "Sign in with ChatGPT" option within the OpenAI provider settings, alongside the existing API key input
- **FR-002**: System MUST open the user's default browser to the ChatGPT authentication page when the user initiates sign-in
- **FR-003**: System MUST securely capture the authentication callback and extract the authorization code without exposing it to other applications
- **FR-004**: System MUST exchange the authorization code for access, refresh, and identity tokens using the PKCE security mechanism
- **FR-005**: System MUST store authentication tokens securely using the operating system's native credential storage (desktop) or browser-managed storage (extension)
- **FR-006**: System MUST automatically refresh the access token before it expires, without requiring user interaction
- **FR-007**: System MUST use the ChatGPT OAuth access token in place of an API key when making requests to OpenAI models
- **FR-008**: System MUST enforce mutual exclusivity between API key and ChatGPT OAuth authentication for the OpenAI provider — activating one deactivates the other
- **FR-009**: System MUST allow users to disconnect their ChatGPT OAuth session from the settings UI
- **FR-010**: System MUST restore the ChatGPT OAuth session on application restart if valid tokens exist in secure storage
- **FR-011**: System MUST show clear connection status (connected, disconnected, signing in, error) in the settings UI
- **FR-012**: System MUST handle authentication failures gracefully — showing user-friendly error messages and allowing retry
- **FR-013**: System MUST protect against cross-site request forgery during the OAuth flow using state parameter validation
- **FR-014**: System MUST time out the authentication flow after 5 minutes if the user does not complete the browser-based login

### Key Entities

- **ChatGPT OAuth Tokens**: A set of credentials obtained from the ChatGPT OAuth flow consisting of an access token (short-lived, used for API calls), a refresh token (long-lived, used to obtain new access tokens), and an optional identity token (contains user profile information). Tokens have an expiration timestamp.
- **Provider Auth Method**: A per-provider setting that tracks which authentication method is active (API key or ChatGPT OAuth). Persisted across application restarts.
- **PKCE Challenge**: A one-time cryptographic challenge pair (verifier and challenge) used during the OAuth flow to prevent authorization code interception. Not persisted — generated fresh for each login attempt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can complete the ChatGPT sign-in flow and send their first message using an OpenAI model within 2 minutes of clicking "Sign in with ChatGPT"
- **SC-002**: Authenticated users experience zero authentication interruptions during a continuous 8-hour session (automatic token refresh works transparently)
- **SC-003**: Authentication state persists across application restarts — users do not need to re-authenticate after closing and reopening BrowserX
- **SC-004**: Switching between API key and ChatGPT OAuth authentication completes within 3 clicks and never leaves the system in an ambiguous authentication state
- **SC-005**: All authentication errors (port conflicts, timeouts, revoked access, network failures) produce a specific, actionable error message visible to the user within 5 seconds of the failure

## Assumptions

- OpenAI's public client ID and redirect URI remain available for third-party integrations. If OpenAI revokes public client access, this feature would stop functioning.
- ChatGPT subscription tiers (Plus, Pro, Business, Enterprise) include API access via the OAuth flow. Rate limits and available models are governed by the user's subscription tier, not by BrowserX.
- The user's default browser supports the standard OAuth redirect flow. Non-standard browsers or highly restrictive corporate proxies may prevent the flow from completing.
- On desktop, the local callback port can be temporarily bound for the duration of the OAuth callback (typically a few seconds). Persistent port conflicts are rare in normal user environments.
- The Chrome extension platform allows monitoring of tab URL changes, which is required for the extension OAuth flow.

## Dependencies

- OpenAI's OAuth infrastructure must remain operational and accessible
- BrowserX's existing secure credential storage (OS keychain on desktop, browser storage on extension) must support storing additional token entries
- The existing OpenAI model client code must accept Bearer tokens interchangeably with API keys (confirmed — both use the same authorization header format)
