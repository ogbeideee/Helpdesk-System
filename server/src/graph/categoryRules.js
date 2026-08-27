const CATEGORY_RULES = [
  {
    category: 'Password Reset',
    priority: 'high',
    keywords: [
      'password',
      'pwd',
      'passcode',
      'forgot my login',
      'reset login',
      'locked out',
      'account locked',
      'unlock',
      'mfa reset',
      'otp',
    ],
  },
  {
    category: 'Software',
    keywords: [
      'software',
      'install',
      'uninstall',
      'license',
      'licence',
      'excel',
      'word',
      'powerpoint',
      'outlook',
      'teams',
      'sharepoint',
      'onedrive',
      'vpn',
      'windows',
      'microsoft office',
      'office 365',
      'office365',
      'browser',
      'chrome',
      'edge',
      'crash',
      'crashing',
      'frozen',
      'bug',
      'error message',
      'update failed',
      'blue screen',
      'bsod',
    ],
  },
  {
    category: 'Hardware',
    keywords: [
      'hardware',
      'printer',
      'laptop',
      'monitor',
      'keyboard',
      'mouse',
      'docking station',
      'dock',
      'headset',
      'webcam',
      'screen broken',
      'cracked screen',
      'battery',
      "won't turn on",
      'wont turn on',
      'overheating',
      'making a noise',
      'dead',
    ],
  },
];

const DEFAULT_CATEGORY = 'Inquiry / Help';
const DEFAULT_PRIORITY = 'moderate';

function classify(text) {
  const haystack = String(text || '').toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      return {
        category: rule.category,
        priority: rule.priority || DEFAULT_PRIORITY,
      };
    }
  }
  return { category: DEFAULT_CATEGORY, priority: DEFAULT_PRIORITY };
}

module.exports = { CATEGORY_RULES, DEFAULT_CATEGORY, DEFAULT_PRIORITY, classify };
