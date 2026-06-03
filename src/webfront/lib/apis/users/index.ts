/**
 * User API functions for making authenticated requests
 */

import { getAccessToken } from '../../utils/cookie';
import { HOME_PAGE_BASE_URL, BACKEND_GENERAL_API } from '../../constants';

export interface UserProfile {
  id?: string;
  name?: string;
  email?: string;
  avatar?: string;
  userType?: number; // 0 = free user, higher values = paid tiers
}

export interface UserCredits {
  plan_id: number;
  plan_name: string;
  daily_basic_credits: number;
  daily_advanced_credits: number;
  monthly_basic_credits: number;
  monthly_advanced_credits: number;
  extra_basic_credits: number;
  extra_advanced_credits: number;
  limited_daily: boolean;
  limited_monthly: boolean;
}

/**
 * Fetch user profile from the API
 * @param providedToken - Optional access token (used by desktop app). If not provided, reads from cookies.
 * @returns User profile or null if failed
 */
export async function fetchUserProfile(providedToken?: string): Promise<UserProfile | null> {
  try {
    const accessToken = providedToken || await getAccessToken();

    if (!accessToken) {
      console.warn('[API] No access token available for fetching user profile');
      return null;
    }

    const baseUrl = HOME_PAGE_BASE_URL;
    if (!baseUrl) {
      console.warn('[API] Hosted auth base URL is not configured for fetching user profile');
      return null;
    }

    const response = await fetch(`${baseUrl}/api/v1/users/profile`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      credentials: 'include', // Include cookies in the request
    });

    if (!response.ok) {
      console.warn(`[API] Failed to fetch user profile: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    // Handle different response structures
    // API returns: { id, email, firstName, lastName, user_type, ... }
    return {
      id: data.id || data.user_id,
      name: data.firstName || data.name || data.display_name || data.username,
      email: data.email,
      avatar: data.avatar || data.avatar_url || data.picture,
      userType: data.user_type ?? 0, // Default to free user (0) if not provided
    };
  } catch (error) {
    console.error('[API] Error fetching user profile:', error);
    return null;
  }
}

/**
 * Fetch user credits from the API
 * @returns User credits or null if failed
 */
export async function fetchUserCredits(): Promise<UserCredits | null> {
  try {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      console.warn('[API] No access token available for fetching user credits');
      return null;
    }

    const response = await fetch(`${BACKEND_GENERAL_API}/users/credits`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      credentials: 'include',
    });

    if (!response.ok) {
      console.warn(`[API] Failed to fetch user credits: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    // The API returns usage_rule nested object containing credit info
    const usageRule = data.usage_rule || data;

    return {
      plan_id: usageRule.plan_id ?? 0,
      plan_name: usageRule.plan_name ?? 'Free',
      daily_basic_credits: usageRule.daily_basic_credits ?? 0,
      daily_advanced_credits: usageRule.daily_advanced_credits ?? 0,
      monthly_basic_credits: usageRule.monthly_basic_credits ?? 0,
      monthly_advanced_credits: usageRule.monthly_advanced_credits ?? 0,
      extra_basic_credits: usageRule.extra_basic_credits ?? 0,
      extra_advanced_credits: usageRule.extra_advanced_credits ?? 0,
      limited_daily: usageRule.limited_daily ?? false,
      limited_monthly: usageRule.limited_monthly ?? false,
    };
  } catch (error) {
    console.error('[API] Error fetching user credits:', error);
    return null;
  }
}
