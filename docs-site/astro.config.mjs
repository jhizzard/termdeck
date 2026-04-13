// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: 'TermDeck · Engram · Rumen',
      description:
        'Docs for the three-tier stack: a browser terminal multiplexer (TermDeck), a long-term memory store (Engram), and an async learning layer (Rumen).',
      // TODO: replace with canonical repo URL when one exists.
      // social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/jhizzard' }],
      sidebar: [
        { label: 'Overview', link: '/' },
        {
          label: 'TermDeck',
          items: [
            { label: 'Introduction', link: '/termdeck/' },
            { label: 'Changelog', link: '/termdeck/changelog/' },
            { label: 'More docs', autogenerate: { directory: 'termdeck/docs' } },
          ],
        },
        {
          label: 'Engram',
          items: [
            { label: 'Introduction', link: '/engram/' },
            { label: 'Changelog', link: '/engram/changelog/' },
            { label: 'More docs', autogenerate: { directory: 'engram/docs' } },
          ],
        },
        {
          label: 'Rumen',
          items: [
            { label: 'Introduction', link: '/rumen/' },
            { label: 'Changelog', link: '/rumen/changelog/' },
            { label: 'More docs', autogenerate: { directory: 'rumen/docs' } },
          ],
        },
        { label: 'Architecture', link: '/architecture/' },
        { label: 'Roadmap', link: '/roadmap/' },
      ],
    }),
  ],
});
