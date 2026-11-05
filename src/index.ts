import { createApp } from './app';
import { GitHubArtifactProvider } from './providers/github';

const app = createApp(new GitHubArtifactProvider());
export default { fetch: app } satisfies ExportedHandler<Env>;
