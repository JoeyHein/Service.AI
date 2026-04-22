import { describe, it, expect, vi } from 'vitest';
import { loggingSender } from './sender.js';

describe('loggingSender', () => {
  it('writes a JSON stub record to stdout when send is called', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await loggingSender.send({
      email: 'joey@opendc.ca',
      url: 'https://api.example/magic?token=abc',
      purpose: 'signin',
    });
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('magic_link_stub');
    expect(parsed.email).toBe('joey@opendc.ca');
    expect(parsed.url).toContain('token=abc');
    expect(parsed.purpose).toBe('signin');
    spy.mockRestore();
  });

  it('defaults purpose to signin when not supplied', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await loggingSender.send({ email: 'x@y.z', url: 'https://u' });
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.purpose).toBe('signin');
    spy.mockRestore();
  });
});
