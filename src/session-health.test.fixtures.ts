// Canned DOM snapshots + sentinel passwords for session-health unit tests.
// Hand-built — not from real Amazon HTML so there are no real credentials
// even by accident.

export const SENTINEL_PASSWORD = 'P@ssw0rdSentinelXYZ-DoNotUseAnywhere';
export const SENTINEL_OTP = '123456';
export const SENTINEL_EMAIL = 'sentinel.user@example.invalid';

// classifyHealth() input fixtures — keyed by expected SessionHealth label.
export const SNAPSHOT_HEALTHY = {
  bodyText: 'Hello, John\nYour Orders\n...',
  bannerIds: [],
  hasOtpField: false,
  hasApprovePushText: false,
  hasAccountLockText: false,
};
export const SNAPSHOT_BANNER_ATTENTION = {
  bodyText: 'Your Orders\nWe need your attention\n...',
  bannerIds: ['AttentionRequiredBanner'],
  hasOtpField: false,
  hasApprovePushText: false,
  hasAccountLockText: false,
};
export const SNAPSHOT_BANNER_RETRIEVAL = {
  bodyText: 'Hello, John\nYour Orders\nProblem retrieving your orders\n...',
  bannerIds: ['OrderRetreivalProblemBanner'],
  hasOtpField: false,
  hasApprovePushText: false,
  hasAccountLockText: false,
};
export const SNAPSHOT_BANNER_UNKNOWN = {
  bodyText: 'Hello, John\nYour Orders\n...',
  bannerIds: ['SomeBrandNewBanner', 'NotEvenABanner'],
  hasOtpField: false,
  hasApprovePushText: false,
  hasAccountLockText: false,
};
export const SNAPSHOT_AUTH_EXPIRED = {
  bodyText: 'Sign-In Email or mobile phone number',
  bannerIds: [],
  hasOtpField: false,
  hasApprovePushText: false,
  hasAccountLockText: false,
};
export const SNAPSHOT_MFA_OTP = {
  bodyText: 'Two-Step Verification\nEnter the OTP',
  bannerIds: [],
  hasOtpField: true,
  hasApprovePushText: false,
  hasAccountLockText: false,
};
export const SNAPSHOT_MFA_PUSH = {
  bodyText: 'Approve this sign-in on your phone',
  bannerIds: [],
  hasOtpField: false,
  hasApprovePushText: true,
  hasAccountLockText: false,
};
export const SNAPSHOT_ACCOUNT_LOCKED = {
  bodyText: 'Your account has been locked',
  bannerIds: [],
  hasOtpField: false,
  hasApprovePushText: false,
  hasAccountLockText: true,
};
export const SNAPSHOT_UNKNOWN = {
  bodyText: 'Something unexpected',
  bannerIds: [],
  hasOtpField: false,
  hasApprovePushText: false,
  hasAccountLockText: false,
};
