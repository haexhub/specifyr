/**
 * Dev-only login: clears the logout cookie so the next request
 * re-applies the SPECIFYR_DEV_USER_EMAIL fallback. Companion to
 * /api/dev/logout.
 */
export default defineEventHandler((event) => {
  if (!process.env.SPECIFYR_DEV_USER_EMAIL) {
    throw createError({ statusCode: 404 });
  }
  deleteCookie(event, "specifyr-dev-loggedout", { path: "/" });
  return { ok: true };
});
