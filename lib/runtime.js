/**
 * True when running as a real deployment rather than on a developer's machine. `netlify dev` imitates the hosted
 * runtime (it sets AWS_LAMBDA_FUNCTION_NAME), so it is told apart by the NETLIFY_DEV flag it also sets.
 */
export function isHosted(env = process.env) {
  return env.NODE_ENV === 'production' || (!!env.AWS_LAMBDA_FUNCTION_NAME && env.NETLIFY_DEV !== 'true');
}
