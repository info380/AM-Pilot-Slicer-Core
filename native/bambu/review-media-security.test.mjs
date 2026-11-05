import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewAdvisories } from './review-media-security.mjs';

const advisory = (id, severity = 'HIGH') => ({ cve: { id, metrics: { cvssMetricV31: [{ cvssData: { baseSeverity: severity } }] } } });
const input = () => ({ feed: { format: 'NVD_CVE', version: '2.0', timestamp: new Date().toISOString(), totalResults: 1, vulnerabilities: [advisory('CVE-test')] }, policy: { sourceSha256: 'source', upstreamVersion: '7.0.2', maximumFeedAgeSeconds: 86400, maximumFutureSkewSeconds: 300, advisories: [{ id: 'CVE-test', reason: 'disabled-parser', upstreamPath: 'libavcodec/parser.c' }] }, evidence: { sourceSha256: 'source', upstreamVersion: '7.0.2', parserCount: 0 } });

test('native exclusions require the exact reviewed source and absent component', () => {
  const value = input(); assert.equal(reviewAdvisories(value).highCriticalReviewed, 1);
  value.evidence.parserCount = 1; assert.throws(() => reviewAdvisories(value));
  value.evidence.parserCount = 0; value.evidence.sourceSha256 = 'other'; assert.throws(() => reviewAdvisories(value));
});
test('unknown high, unscored and incomplete advisory feeds fail closed', () => {
  for (const change of [x => x.feed.vulnerabilities[0] = advisory('CVE-new'), x => x.feed.vulnerabilities[0].cve.metrics = {}, x => x.feed.totalResults++, x => x.feed.timestamp = '2000-01-01T00:00:00Z', x => x.feed.format = 'other']) {
    const value = input(); change(value); assert.throws(() => reviewAdvisories(value));
  }
});
test('all scoring authorities are considered and lower-severity findings are not relabelled', () => {
  const value = input(); value.feed.vulnerabilities[0] = advisory('CVE-new', 'LOW');
  assert.equal(reviewAdvisories(value).highCriticalReviewed, 0);
  value.feed.vulnerabilities[0].cve.metrics.cvssMetricV40 = [{ cvssData: { baseSeverity: 'CRITICAL' } }];
  assert.throws(() => reviewAdvisories(value), /Unreviewed/);
});
