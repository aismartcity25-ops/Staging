/**
 * Utility per la gestione dell'autenticazione
 * Note: Requires api-config.js to be loaded first
 */

async function checkAuth(expectedProduct) {
  try {
    const res = await fetch(ApiConfig.get('me'), { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    const user = data.user;

    // Not authenticated -> redirect to login
    if (!user) {
      window.location.href = `/login_${expectedProduct}.html`;
      return null;
    }

    // Check if user has access to the expected product
    if (user.currentProduct !== expectedProduct) {
      // Redirect to the correct product
      window.location.href = `/login_${expectedProduct}.html`;
      return null;
    }

    return user;
  } catch (e) {
    console.error('Auth check failed:', e);
    window.location.href = '/login_comunicai.html';
    return null;
  }
}

async function logout(product) {
  try {
    await fetch(ApiConfig.get('logout'), { method: 'POST', credentials: 'include' });
  } catch (e) {
    console.error('Logout failed:', e);
  }
  window.location.href = `/login_${product}.html`;
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.checkAuth = checkAuth;
  window.logout = logout;
}
