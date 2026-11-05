export type YouTubeAuthMode = 'apiKey' | 'oauth';

const fields: Record<
  string,
  {
    key: string;
    label: string;
    placeholder: string;
    secret?: boolean;
    optional?: boolean;
  }[]
> = {
  channels: [
    {
      key: 'url',
      label: 'Channels DVR server URL',
      placeholder: 'http://192.168.1.20:8089',
    },
  ],
  xtream: [
    {
      key: "url",
      label: "Provider URL",
      placeholder: "https://provider.example:8080",
    },
    { key: "username", label: "Username", placeholder: "Your IPTV username" },
    {
      key: "password",
      label: "Password",
      placeholder: "Your IPTV password",
      secret: true,
    },
  ],
  m3u: [
    {
      key: "url",
      label: "Playlist URL",
      placeholder: "https://provider.example/playlist.m3u",
      optional: true,
    },
  ],
  plex: [
    {
      key: "url",
      label: "Plex server URL",
      placeholder: "http://192.168.1.10:32400",
    },
    {
      key: "token",
      label: "Plex token",
      placeholder: "Your server access token",
      secret: true,
    },
  ],
  drive: [
    {
      key: "clientId",
      label: "Google OAuth client ID",
      placeholder: "Your Google Cloud web client ID",
    },
    {
      key: "clientSecret",
      label: "Google OAuth client secret",
      placeholder: "Your client secret",
      secret: true,
    },
    {
      key: "folderId",
      label: "Start folder ID (optional)",
      placeholder: "Leave blank for My Drive",
      optional: true,
    },
  ],
  local: [
    {
      key: "rootPath",
      label: "Folder on the server",
      placeholder: "/media or /Volumes/MyShare/Movies",
    },
  ],
  youtube: [
    {
      key: "apiKey",
      label: "YouTube Data API key",
      placeholder: "A key with YouTube Data API v3 enabled",
      secret: true,
    },
  ],
};
export function connectionFields(type: string, mode: YouTubeAuthMode) {
  return type === 'youtube' && mode === 'oauth'
    ? fields.drive.filter(field => field.key !== 'folderId')
    : fields[type] || [];
}

export function youtubeAuthMode(config: Record<string, string>, configuredFields: string[]): YouTubeAuthMode {
  return config.authMode === 'oauth' || (!config.authMode && (configuredFields.includes('refreshToken') || configuredFields.includes('accessToken')))
    ? 'oauth' : 'apiKey';
}
