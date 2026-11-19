export interface GoogleUserProfile {
  googleId: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
}

/**
 * Verify a Google OAuth ID Token using Google's public tokeninfo endpoint
 */
export async function verifyGoogleIdToken(idToken: string): Promise<{ success: boolean; user?: GoogleUserProfile; error?: string }> {
  if (!idToken || typeof idToken !== 'string') {
    return { success: false, error: 'Missing or invalid Google ID token' };
  }

  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken.trim())}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return {
        success: false,
        error: (errData as any)?.error_description || (errData as any)?.error || 'Google token verification failed'
      };
    }

    const payload = (await res.json()) as any;

    const email = (payload.email || '').trim().toLowerCase();
    const googleId = payload.sub;
    const name = payload.name || payload.given_name || 'Google Merchant';
    const picture = payload.picture;
    const emailVerified = payload.email_verified === 'true' || payload.email_verified === true;

    if (!email || !googleId) {
      return { success: false, error: 'Incomplete Google profile returned' };
    }

    // Optional audience check if GOOGLE_CLIENT_ID configured
    const configuredClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    if (configuredClientId && payload.aud && payload.aud !== configuredClientId) {
      return { success: false, error: 'Google Client ID audience mismatch' };
    }

    return {
      success: true,
      user: {
        googleId,
        email,
        name,
        picture,
        emailVerified
      }
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Network error verifying Google ID token: ${err?.message || err}`
    };
  }
}
