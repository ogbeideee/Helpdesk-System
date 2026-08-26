// Kept as a thin re-export so existing Graph code keeps its import path while
// the actual implementation lives in the provider-independent email module.
// One converter, one set of rules — see src/email/htmlToText.js.
const { htmlToPlainText, decodeEntities } = require('../email/htmlToText');

module.exports = {
  /** @deprecated prefer htmlToPlainText from src/email/htmlToText.js */
  extractText: htmlToPlainText,
  htmlToPlainText,
  decodeEntities,
};
