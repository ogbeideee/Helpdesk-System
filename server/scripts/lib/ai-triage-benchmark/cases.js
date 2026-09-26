// Small synthetic smoke set for the email relevance benchmark. This is not a
// replacement for the administrator-labeled 200–500 message benchmark; it is a
// safe first check that the provider and prompt are wired correctly.

const CASES = [
  {
    id: 'hr-announcement',
    subject: 'Annual HR policy update',
    cleanBody: 'The annual policy update is for information. No action is required.',
    from: 'hr-announcements@example.com',
    expected: 'skip',
  },
  {
    id: 'birthday',
    subject: 'Happy birthday to the Finance team',
    cleanBody: 'Wishing the Finance team a wonderful birthday.',
    from: 'celebrations@example.com',
    expected: 'skip',
  },
  {
    id: 'newsletter',
    subject: 'Weekly technology newsletter',
    cleanBody: 'Here are this week’s technology headlines. Browse the full newsletter online.',
    from: 'newsletter@example.com',
    expected: 'skip',
  },
  {
    id: 'all-hands',
    subject: 'All-hands meeting reminder',
    cleanBody: 'The all-hands meeting is tomorrow. No response is required.',
    from: 'all-hands@example.com',
    expected: 'skip',
  },
  {
    id: 'onboarding-request',
    subject: 'Could you send the onboarding checklist?',
    cleanBody: 'I am starting next week. Could you send me the latest onboarding checklist?',
    from: 'employee@example.com',
    expected: 'ticket',
  },
  {
    id: 'laptop-failure',
    subject: 'My laptop screen is blank',
    cleanBody: 'My laptop screen is blank and I cannot work on it.',
    from: 'employee@example.com',
    expected: 'ticket',
  },
  {
    id: 'password-reset',
    subject: 'Locked out of my account',
    cleanBody: 'I am locked out and need my password reset.',
    from: 'employee@example.com',
    expected: 'ticket',
  },
  {
    id: 'security-incident',
    subject: 'Suspicious sign-in alert',
    cleanBody: 'There is a suspicious sign-in and I need security help.',
    from: 'employee@example.com',
    expected: 'ticket',
  },
  {
    id: 'mixed-message',
    subject: 'Policy update — application unavailable',
    cleanBody: 'The policy is attached. The application is unavailable and I need help.',
    from: 'employee@example.com',
    expected: 'review',
  },
  {
    id: 'it-word-in-announcement',
    subject: 'IT maintenance announcement',
    cleanBody: 'The IT maintenance window is listed below. This is an announcement only.',
    from: 'it-notice@example.com',
    expected: 'skip',
  },
  {
    id: 'out-of-office',
    subject: 'Out of office',
    cleanBody: 'I am away and will respond when I return. This is an automatic notice.',
    from: 'employee@example.com',
    expected: 'skip',
  },
  {
    id: 'vendor-notice',
    subject: 'Vendor maintenance notice',
    cleanBody: 'The vendor will perform maintenance next week. No action is required.',
    from: 'vendor@example.com',
    expected: 'skip',
  },
];

module.exports = { CASES };
