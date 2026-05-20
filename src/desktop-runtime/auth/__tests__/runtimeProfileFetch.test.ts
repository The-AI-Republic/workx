import { describe, expect, it } from 'vitest';
import { profileFromAccessToken } from '../runtimeProfileFetch';

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64url');
  return `header.${encoded}.signature`;
}

describe('profileFromAccessToken', () => {
  it('derives a minimal profile from JWT claims', () => {
    const token = jwtWithPayload({
      sub: 'user-1',
      email: 'rich@example.com',
      name: 'Rich',
      picture: 'https://example.com/avatar.png',
      user_type: 1,
    });

    expect(profileFromAccessToken(token)).toEqual({
      id: 'user-1',
      email: 'rich@example.com',
      name: 'Rich',
      avatar: 'https://example.com/avatar.png',
      userType: 1,
    });
  });

  it('returns null when the token has no profile-like claims', () => {
    expect(profileFromAccessToken(jwtWithPayload({ type: 'access' }))).toBeNull();
    expect(profileFromAccessToken('not-a-jwt')).toBeNull();
  });
});
