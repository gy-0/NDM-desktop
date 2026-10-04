import json
import pathlib
import ssl
import tempfile
import unittest
from identity_guard import IdentityGuard

class IdentityStoreTests(unittest.TestCase):
    def test_valid_pin_is_loaded_without_reset(self):
        with tempfile.TemporaryDirectory() as root:
            path=pathlib.Path(root)/'pins.json'
            path.write_text(json.dumps({'version':1,'origin':'http://127.0.0.1:12345','pins':{'/file':'"old"'}}))
            before=path.read_bytes()
            guard=IdentityGuard(12345,path)
            try: self.assertEqual(guard.pins,{'/file':'"old"'})
            finally: guard.server_close()
            self.assertEqual(path.read_bytes(),before)

    def test_corrupt_legacy_and_wrong_origin_stores_fail_closed(self):
        cases=['{', '{}', json.dumps({'/file':'"old"'}),
               json.dumps({'version':1,'origin':'http://127.0.0.1:54321','pins':{'/file':'"old"'}}),
               json.dumps({'version':1,'origin':'http://127.0.0.1:12345','pins':{'/file':'W/"old"'}})]
        for contents in cases:
            with self.subTest(contents=contents),tempfile.TemporaryDirectory() as root:
                path=pathlib.Path(root)/'pins.json';path.write_text(contents)
                with self.assertRaises(ValueError): IdentityGuard(12345,path)
                self.assertEqual(path.read_text(),contents)

    def test_transport_change_cannot_reuse_http_pins(self):
        with tempfile.TemporaryDirectory() as root:
            path=pathlib.Path(root)/'pins.json'
            path.write_text(json.dumps({'version':1,'origin':'http://127.0.0.1:12345','pins':{'/file':'"old"'}}))
            with self.assertRaises(ValueError): IdentityGuard(12345,path,ssl.create_default_context())

if __name__=='__main__': unittest.main()
