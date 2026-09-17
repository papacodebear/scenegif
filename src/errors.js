export class SceneGifError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

export class NoResultsError extends SceneGifError {}
export class DownloadBlockedError extends SceneGifError {}
export class RenderError extends SceneGifError {}
