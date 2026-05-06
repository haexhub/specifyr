/**
 * Dev-only logout: sets a cookie that suppresses the
 * SPECIFYR_DEV_USER_EMAIL auto-login. Pairs with /api/dev/login that
 * clears the cookie. Disabled in production: returns 404 unless
 * SPECIFYR_DEV_USER_EMAIL is set (i.e. you're explicitly running in
 * dev-auth mode).
 *
 * Production logout goes through the IDP (Authentik invalidation flow).
 */
export default defineEventHandler((event) => {
  if (!process.env.SPECIFYR_DEV_USER_EMAIL) {
    throw createError({ statusCode: 404 });
  }
  setCookie(event, "specifyr-dev-loggedout", "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 30 days — covers a typical dev session of "I want to stay logged
    // out while testing the unauth UI".
    maxAge: 30 * 24 * 60 * 60,
  });
  return { ok: true };
});
