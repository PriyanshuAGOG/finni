import { describe, expect, it } from 'vitest';
import { classifyKnowledgeCategory } from '../../src/services/knowledge-category';

describe('canonical knowledge category classifier', () => {
  it('classifies movement, exercise and yoga content', () => {
    const result = classifyKnowledgeCategory(
      'Post-meal walking and glucose control',
      'Participants completed a 15 minute walk after meals and increased physical activity.',
    );
    expect(result.slug).toBe('movement-exercise-yoga');
  });

  it('classifies lifestyle content', () => {
    const result = classifyKnowledgeCategory(
      'Sleep duration and metabolic health',
      'The study assessed sleep quality, stress, routines and circadian timing.',
    );
    expect(result.slug).toBe('lifestyle');
  });

  it('classifies food content', () => {
    const result = classifyKnowledgeCategory(
      'Dietary fibre and HbA1c',
      'The intervention increased fibre intake through food and measured nutrition outcomes.',
    );
    expect(result.slug).toBe('food');
  });

  it('uses Miscellaneous when none of the three primary categories fits', () => {
    const result = classifyKnowledgeCategory(
      'New health data interoperability standard',
      'The document describes software exchange formats and governance requirements.',
    );
    expect(result.slug).toBe('miscellaneous');
  });

  it('lets a clear title outweigh incidental body mentions', () => {
    const result = classifyKnowledgeCategory(
      'Sleep habits and insulin sensitivity',
      'Diet was recorded as a covariate. Diet diet diet diet diet diet diet diet.',
    );
    expect(result.slug).toBe('lifestyle');
  });
});
