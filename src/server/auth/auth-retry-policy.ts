/** At most one automatic expired-auth retry, and never after a possible side effect. */
export function shouldAutomaticallyRetryExpiredAuth(alreadyRetried: boolean, retrySafe: boolean): boolean {
  return !alreadyRetried && retrySafe;
}
