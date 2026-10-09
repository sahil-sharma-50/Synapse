export const DEFAULT_GREETINGS = [
  "Hey there. Good to see you!",
  "Hello! I'm here whenever you need me.",
  "Welcome back. What's on your mind?",
  "Hey! Let's make something happen.",
  "Hi there. Ready when you are.",
];

export function chooseGreeting(custom = ""): string {
  const greetings = custom
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const choices = greetings.length ? greetings : DEFAULT_GREETINGS;
  return choices[Math.floor(Math.random() * choices.length)];
}
