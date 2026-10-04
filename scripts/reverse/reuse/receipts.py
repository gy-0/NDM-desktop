"""Single-producer research submission receipts. Uncertain requests are never resent."""
import hashlib
import json
import os
import sqlite3

def read_records(database):
    with sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute('SELECT id,url,method FROM downloads')]

class UncertainSubmission(RuntimeError): pass

class Receipts:
    def __init__(self, path):
        self.path = path
        self.rows = json.loads(path.read_text()) if path.exists() else {}

    def save(self):
        temporary = self.path.with_suffix('.tmp')
        with temporary.open('w') as stream:
            json.dump(self.rows, stream)
            stream.flush(); os.fsync(stream.fileno())
        temporary.replace(self.path)
        directory = os.open(self.path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)

    def begin(self, key, url, method, body, records):
        fingerprint = hashlib.sha256(json.dumps([url,method,hashlib.sha256(body or b'').hexdigest()]).encode()).hexdigest()
        if key in self.rows:
            if self.rows[key]['fingerprint'] != fingerprint: raise ValueError('Receipt key reused for a different request')
            return self.recover(key, records)
        if any(row['state']=='pending' for row in self.rows.values()):
            raise UncertainSubmission('Resolve the previous pending submission before sending another')
        self.rows[key] = {'fingerprint':fingerprint,'url':url,'method':method,'before':[str(r['id']) for r in records],'state':'pending'}
        self.save()
        return None

    def confirm(self, key, task_id):
        self.rows[key].update(state='confirmed', taskID=str(task_id))
        self.save()
        return str(task_id)

    def recover(self, key, records):
        row = self.rows[key]
        if row['state']=='confirmed': return row['taskID']
        # GET only: a POST body is not exposed by the current safe record snapshot.
        matches = [r for r in records if str(r['id']) not in row['before'] and r.get('url')==row['url'] and r.get('method')==row['method']]
        if row['method']=='GET' and len(matches)==1: return self.confirm(key,matches[0]['id'])
        raise UncertainSubmission('Pending submission cannot be uniquely correlated; do not resend')
