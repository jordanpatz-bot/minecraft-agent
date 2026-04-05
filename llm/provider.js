#!/usr/bin/env node
'use strict';
/**
 * llm/provider.js — LLM provider abstraction.
 * Supports Claude API and Ollama for local inference.
 */

const { spawn } = require('child_process');

class LLMProvider {
  constructor(opts = {}) {
    this.provider = opts.provider || 'claude';
    this.model = opts.model || 'haiku';
    this.ollamaModel = opts.ollamaModel || 'gemma4';
    this.ollamaEndpoint = opts.ollamaEndpoint || 'http://localhost:11434';
    this.tokenCount = 0;
  }

  /**
   * Call the LLM with a system prompt and user message.
   * Returns the response text.
   */
  async call(systemPrompt, userMessage, opts = {}) {
    const model = opts.model || this.model;

    if (this.provider === 'claude') {
      return this._callClaude(systemPrompt, userMessage, model);
    } else if (this.provider === 'ollama') {
      return this._callOllama(systemPrompt, userMessage);
    }
    throw new Error(`Unknown provider: ${this.provider}`);
  }

  async _callClaude(systemPrompt, userMessage, model) {
    const modelMap = {
      haiku: 'claude-haiku-4-5-20251001',
      sonnet: 'claude-sonnet-4-6',
      opus: 'claude-opus-4-6',
    };
    const modelId = modelMap[model] || model;

    // Try Anthropic SDK first (requires ANTHROPIC_API_KEY)
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic();
        const response = await client.messages.create({
          model: modelId,
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });
        const text = response.content[0]?.text || '';
        this.tokenCount += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
        return text;
      } catch (e) {
        console.warn('[LLM] SDK failed, falling back to CLI:', e.message);
      }
    }
    // Fallback: Claude CLI (already authenticated)
    return this._callClaudeCLI(systemPrompt, userMessage, model);
  }

  async _callClaudeCLI(systemPrompt, userMessage, model) {
    return new Promise((resolve, reject) => {
      const input = `${systemPrompt}\n\n---\n\n${userMessage}`;
      const proc = spawn('claude', ['-p', input, '--model', model], {
        timeout: 60000,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => {
        if (code !== 0) reject(new Error(`Claude CLI failed: ${stderr}`));
        else resolve(stdout.trim());
      });
    });
  }

  async _callOllama(systemPrompt, userMessage) {
    const resp = await fetch(`${this.ollamaEndpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.ollamaModel,
        prompt: `${systemPrompt}\n\n${userMessage}`,
        stream: false,
      }),
    });
    const data = await resp.json();
    return data.response || '';
  }
}

/**
 * Extract JSON from LLM response (handles markdown code fences).
 */
function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text); } catch {}
  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }
  // Try to find JSON object/array in the text
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch {}
  }
  return null;
}

module.exports = { LLMProvider, extractJSON };
