import { create } from "zustand";

export type Route =
  | { kind: "home" | "requests" | "settings" | "upgrade" }
  | { kind: "user"; userId: string }
  | { kind: "wishlist"; wishlistId: string }
  | { kind: "product"; productId: string; sessionId?: string }
  | { kind: "session"; sessionId: string };

export const useNavigation = create<{
  route: Route;
  history: Route[];
  go: (route: Route) => void;
  back: () => void;
}>((set) => ({
  route: { kind: "home" },
  history: [],
  go: (route) => set((state) => ({ route, history: [...state.history, state.route] })),
  back: () => set((state) => ({ route: state.history.at(-1) || { kind: "home" }, history: state.history.slice(0, -1) })),
}));
