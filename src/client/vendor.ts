import React from 'react';
import * as ReactDOM from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

// Keep the single-file UI while resolving all browser dependencies from bun.lock.
Object.assign(window, { React, ReactDOM, marked, DOMPurify, hljs });
