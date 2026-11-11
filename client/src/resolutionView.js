// Suggested wording only: agents must choose notes that reflect the work done.
const NOTES = {
  'Password Reset': [
    'The account password was reset and access restored.',
    'The account was unlocked and sign-in access restored.',
    'The password reset issue was resolved and access verified.',
  ],
  'Software': [
    'The application was repaired and verified to be working.',
    'The application configuration was corrected and functionality restored.',
    'The software was updated and the reported issue resolved.',
  ],
  'Hardware': [
    'The faulty component was replaced and the device tested successfully.',
    'The device connection was restored and operation verified.',
    'The hardware fault was repaired and normal operation restored.',
  ],
  'Inquiry / Help': [
    'The requested information was provided and the inquiry addressed.',
    'The required guidance was provided and the issue resolved.',
    'The requested assistance was provided and the task completed.',
  ],
};

export function resolutionSuggestions(category) {
  return [...(NOTES[category] || [])];
}
