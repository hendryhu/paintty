import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import NumberField from '../src/components/NumberField.svelte';
import ExportPopup from '../src/components/ExportPopup.svelte';
import { notifyProjectReplaced } from '../src/lib/documentLifecycle.js';

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-number-field-outside]').forEach((node) => node.remove());
});

function outsideTarget(onPointerDown = null) {
  const button = document.createElement('button');
  button.textContent = 'Outside action';
  button.dataset.numberFieldOutside = '';
  if (onPointerDown) button.addEventListener('pointerdown', onPointerDown);
  document.body.append(button);
  return button;
}

describe('mounted number draft pointer policy', () => {
  test('same-field pointer preserves a draft and the next outside pointer sees one commit', async () => {
    const published = [];
    const changes = [];
    render(NumberField, {
      value: 5, min: 1, max: 20, ariaLabel: 'Amount',
      onInput: ({ value }) => published.push(value),
      onChange: ({ value }) => changes.push(value),
    });
    const input = screen.getByRole('spinbutton', { name: 'Amount' });

    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: '7' } });
    await fireEvent.pointerDown(input, { button: 0, pointerId: 11, clientX: 10 });
    await fireEvent.pointerUp(window, { pointerId: 11, clientX: 10 });
    expect(input.dataset.dirty).toBe('true');
    expect(published).toEqual([]);
    expect(changes).toEqual([]);

    let observedAtTarget = null;
    const outside = outsideTarget(() => {
      observedAtTarget = published.at(-1) ?? null;
    });
    await fireEvent.pointerDown(outside, { button: 0, pointerId: 12 });
    expect(observedAtTarget).toBe(7);
    expect(published).toEqual([7]);
    expect(changes).toEqual([7]);
    expect(input.dataset.dirty).toBe('false');
    expect(document.activeElement).not.toBe(input);
  });

  test('Escape and project replacement discard drafts before later pointers', async () => {
    const changes = [];
    render(NumberField, {
      value: 5, ariaLabel: 'Replace-safe amount',
      onChange: ({ value }) => changes.push(value),
    });
    const input = screen.getByRole('spinbutton', { name: 'Replace-safe amount' });
    const outside = outsideTarget();

    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: '9' } });
    await fireEvent.keyDown(input, { key: 'Escape' });
    await fireEvent.pointerDown(outside, { button: 0, pointerId: 21 });
    expect(input.value).toBe('5');
    expect(input.dataset.dirty).toBe('false');
    expect(changes).toEqual([]);

    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: '8' } });
    notifyProjectReplaced();
    await tick();
    await fireEvent.pointerDown(outside, { button: 0, pointerId: 22 });
    expect(input.value).toBe('5');
    expect(input.dataset.dirty).toBe('false');
    expect(changes).toEqual([]);
  });

  test('Export cell-size preview updates on the first outside pointer-down', async () => {
    render(ExportPopup);
    await tick();
    const input = screen.getByRole('spinbutton', { name: 'Cell size' });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: '23' } });
    expect(screen.getByText(/16px wide/)).not.toBeNull();

    await fireEvent.pointerDown(screen.getByRole('button', { name: 'Export', exact: true }), {
      button: 0,
      pointerId: 31,
    });
    await tick();
    expect(screen.getByText(/23px wide.*46px tall/)).not.toBeNull();
    expect(input.dataset.dirty).toBe('false');
  });
});
