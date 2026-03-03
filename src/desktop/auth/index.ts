/**
 * Desktop Authentication Module
 *
 * Exports authentication services for the Apple Pi desktop app.
 *
 * @module desktop/auth
 */

export {
  DesktopAuthService,
  getDesktopAuthService,
  type UserSession,
  type AuthState,
} from './DesktopAuthService';
