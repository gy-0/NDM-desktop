import pathlib
import tempfile
import unittest
import sqlite3
from receipts import Receipts, UncertainSubmission, read_records

class ReceiptTests(unittest.TestCase):
    def test_recovery_uses_persisted_request_metadata_without_writing_database(self):
        with tempfile.TemporaryDirectory() as root:
            database=pathlib.Path(root)/'engine.db'
            with sqlite3.connect(database) as connection:
                connection.execute('CREATE TABLE downloads(id INTEGER,url TEXT,method TEXT)')
                connection.execute("INSERT INTO downloads VALUES (7,'http://fixture/file','GET')")
            original=database.read_bytes()
            journal=Receipts(pathlib.Path(root)/'receipts.json')
            journal.begin('request','http://fixture/file','GET',None,[])
            self.assertEqual(Receipts(journal.path).recover('request',read_records(database)),'7')
            self.assertEqual(database.read_bytes(),original)

    def test_pending_without_unique_record_never_becomes_confirmed(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root)/'receipts.json'
            journal = Receipts(path)
            journal.begin('request','http://fixture/file','GET',None,[])
            for records in ([], [{'id':1,'url':'http://fixture/file','method':'GET'}, {'id':2,'url':'http://fixture/file','method':'GET'}]):
                restarted = Receipts(path)
                with self.assertRaises(UncertainSubmission): restarted.recover('request',records)
                self.assertEqual(Receipts(path).rows['request']['state'],'pending')

    def test_pending_request_blocks_a_second_submission(self):
        with tempfile.TemporaryDirectory() as root:
            journal = Receipts(pathlib.Path(root)/'receipts.json')
            journal.begin('first','http://fixture/file','GET',None,[])
            with self.assertRaises(UncertainSubmission): journal.begin('second','http://fixture/file','GET',None,[])
            self.assertNotIn('second',Receipts(journal.path).rows)

    def test_same_url_post_is_not_enough_to_recover_unknown_body(self):
        with tempfile.TemporaryDirectory() as root:
            journal = Receipts(pathlib.Path(root)/'receipts.json')
            journal.begin('request','http://fixture/file','POST',b'a=1',[])
            with self.assertRaises(UncertainSubmission):
                journal.recover('request',[{'id':1,'url':'http://fixture/file','method':'POST'}])

    def test_reused_key_cannot_change_request(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root)/'receipts.json'
            journal = Receipts(path)
            journal.begin('request','http://fixture/file','POST',b'a=1',[])
            original = path.read_bytes()
            with self.assertRaises(ValueError): journal.begin('request','http://fixture/file','POST',b'a=2',[])
            self.assertEqual(path.read_bytes(),original)

    def test_preexisting_matching_record_is_not_new_acceptance(self):
        with tempfile.TemporaryDirectory() as root:
            journal = Receipts(pathlib.Path(root)/'receipts.json')
            record={'id':1,'url':'http://fixture/file','method':'GET'}
            journal.begin('request',record['url'],'GET',None,[record])
            with self.assertRaises(UncertainSubmission): journal.recover('request',[record])

if __name__ == '__main__': unittest.main()
