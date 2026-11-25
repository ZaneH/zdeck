# zDeck Agent Guide

## Purpose

Build zDeck as a self-contained application that can control a user's computer and its applications using dashboard
created by the user.

## Feature Map

## Invariants

- Settings errors never prevent launch.
- Windows, macOS, and Linux must all be supported. Platform-specific features require supported implementations and verification on all three; silently unsupported behavior is not acceptable.

## UI signal

Reduce noise while retaining actionable signal. Expected platform limitations should not repeat as warnings after an operation completes: native play/pause can send a media key without observable playback state, so keep the state honestly unknown without a warning or forced refresh after each press. Genuine failures and uncertain delivery still need warnings and retry safeguards. A permission-blocked control gets a focused short prompt and one setup CTA, not an appended troubleshooting wall.

