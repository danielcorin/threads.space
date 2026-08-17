// The global feedback channel and the bot that owns it + authors the canned
// "Dan" auto-replies. Seeded into every instance by
// the fresh baseline migration. The client mirrors FEEDBACK_CHANNEL_ID in
// client/src/lib/constants.ts.
export const FEEDBACK_CHANNEL_ID = 'feedback';
export const FEEDBACK_BOT_ID = 'feedback-bot';
export const FEEDBACK_BOT_DISPLAY_NAME = 'Dan';
// Display-name color for the "Dan" replies (the app's palette green /
// --color-success). Mirrored in the baseline seed so the persisted reply is
// green on reload too, not just in the live broadcast.
export const FEEDBACK_BOT_NAME_COLOR = '#2ecc71';

// Canned acknowledgements, rotated in order per human feedback message so a
// poster gets a friendly reply without any real-time human in the loop.
export const FEEDBACK_REPLIES = [
  'Got it — thanks for the feedback!',
  'Thanks, will take a look.',
  'Appreciate you flagging this.',
  'Noted — thank you!',
  'Thanks for letting me know.',
  'Got it, on it.',
];
