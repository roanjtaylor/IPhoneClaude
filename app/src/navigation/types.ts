// Typed route params for the native-stack navigator.
export type RootStackParamList = {
  /**
   * The home screen. No conversationId ⇒ a fresh "new chat" (the row is created lazily on
   * first send). `incognito` keeps the session in memory only. `sessionKey` distinguishes
   * successive new-chat sessions so starting another new chat resets the screen.
   */
  Chat: { conversationId?: string; title?: string; incognito?: boolean; sessionKey?: number };
  /** Full chat history with search + edit/rename/delete (reached from the sidebar). */
  ConversationList: undefined;
  Settings: undefined;
  ImageViewer: { uri: string };
  Projects: undefined;
  ProjectDetail: { projectId: string; title?: string };
};
