import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown lists', () => {
  it('keeps nested bullets under their numbered item and continues numbering', () => {
    const html = renderToStaticMarkup(<Markdown text={'1. **First**\n   - detail a\n   - detail b\n2. Second\n\nPara\n\n3. Third'} />);
    expect(html).toContain('<ol class="md-list"><li><strong>First</strong><ul class="md-list"><li>detail a</li><li>detail b</li></ul></li><li>Second</li></ol>');
    expect(html).toContain('<ol class="md-list" start="3"><li>Third</li></ol>');
  });

  it('splits a numbered list from a following top-level bullet list', () => {
    const html = renderToStaticMarkup(<Markdown text={'1. One\n- loose bullet'} />);
    expect(html).toContain('<ol class="md-list"><li>One</li></ol><ul class="md-list"><li>loose bullet</li></ul>');
  });
});

describe('Markdown emphasis', () => {
  it('keeps underscores inside words, and italicizes only at word edges', () => {
    const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
    expect(html('Use look_at_app on index.html')).toContain('Use look_at_app on index.html');
    expect(html('cart_total and __init__ and snake_case_name')).toContain('cart_total and __init__ and snake_case_name');
    expect(html('a file_name_ here')).not.toContain('<em>');
    expect(html('this is _really_ important')).toContain('this is <em>really</em> important');
    expect(html('_a_ and (_two words_).')).toContain('<em>a</em> and (<em>two words</em>).');
    expect(html('spaces _ like this _ stay')).not.toContain('<em>');
    expect(html('café_au_lait')).toContain('café_au_lait');
  });
});
