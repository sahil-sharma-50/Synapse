export type DesktopChoice = { id: string; name: string; kind: string; location: string };
export type DesktopContextEvent = {
  session: number;
  turn: number;
  generation: number;
  app: string;
  title: string;
  question: string;
  choices: { id: string; items: DesktopChoice[] } | null;
  partial: boolean;
  scope: string[];
};
export type DesktopChoiceState = {
  session: number;
  turn: number;
  context: DesktopContextEvent | null;
};
export function reduceDesktopContext(
  state: DesktopChoiceState,
  event: DesktopContextEvent,
): DesktopChoiceState {
  return event.session === state.session && event.turn === state.turn
    ? { ...state, context: event }
    : state;
}
