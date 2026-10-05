import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from './source';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout tree={source.pageTree} nav={{ title: 'Upvote' }}>
      {children}
    </DocsLayout>
  );
}