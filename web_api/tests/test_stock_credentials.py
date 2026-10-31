"""Synthetic keys and injected stores/framework only: no real credentials/network."""
import ctypes
import io
import json
from pathlib import Path
import types
import pytest
from scripts import configure_stock_key as cli
module = cli._credentials

KEY = b'synthetic-offline-stock-key'

class Store:
    def __init__(self, previous=None): self.value=previous;self.reads=[];self.adds=[]
    def read(self,service,account): self.reads.append((service,account));return self.value
    def add(self,service,account,secret):
        self.adds.append((service,account)); self.value=secret

@pytest.fixture(autouse=True)
def no_real_framework(monkeypatch):
    monkeypatch.setattr(module.ctypes,'CDLL',lambda *a,**k:pytest.fail('tests must not access the real Keychain'))

@pytest.mark.parametrize('provider,service',list(module.PROVIDERS.items()))
def test_new_key_added_once_and_read_back_verified(provider,service):
    store=Store(); result=module.save_key(provider,KEY,environment={},store=store)
    assert result=={'provider':provider,'service':service,'configured':True,'saved':True,'verified':True}
    assert store.reads==[(service,'zhejiang-tourism-stock')]*2
    assert store.adds==[(service,'zhejiang-tourism-stock')] and store.value==KEY
    assert KEY.decode() not in json.dumps(result)

@pytest.mark.parametrize('provider',['PEXELS','unknown','miaoapi','',None,True])
def test_closed_provider_list_stops_before_store(provider):
    store=Store()
    with pytest.raises(module.StockCredentialError) as failure: module.save_key(provider,KEY,environment={},store=store)
    assert failure.value.code=='invalid_provider' and not store.reads and not store.adds

@pytest.mark.parametrize('key',['',b'',None,True,'bad key','tab\tkey','new\nline','a\0b','a\x7fb','中文',b'\xff',b'x'*2049])
def test_invalid_or_too_long_key_never_reads_or_adds(key):
    store=Store()
    with pytest.raises(module.StockCredentialError) as failure: module.save_key('pexels',key,environment={},store=store)
    assert failure.value.code=='invalid_key' and not store.reads and not store.adds

@pytest.mark.parametrize('size',[1,2048])
def test_exact_byte_bounds_are_accepted(size):
    store=Store();result=module.save_key('pixabay',b'x'*size,environment={},store=store)
    assert result['verified'] and result['saved']

def test_matching_environment_has_precedence_and_is_not_persisted():
    store=Store(b'different-stored-synthetic');env={'PEXELS_API_KEY':KEY.decode()}
    result=module.save_key('pexels',KEY,environment=env,store=store)
    assert result['verified'] and not result['saved'] and not store.reads and not store.adds
    assert env=={'PEXELS_API_KEY':KEY.decode()} and store.value==b'different-stored-synthetic'

@pytest.mark.parametrize('current,code',[(b'another-valid-synthetic','environment_conflict'),(b'bad value','environment_invalid')])
def test_environment_conflict_or_invalid_value_is_not_overwritten(current,code):
    store=Store();env={'PEXELS_API_KEY':current.decode()}
    with pytest.raises(module.StockCredentialError) as failure:module.save_key('pexels',KEY,environment=env,store=store)
    assert failure.value.code==code and not store.reads and not store.adds and env['PEXELS_API_KEY']==current.decode()
    assert KEY.decode() not in str(failure.value)

def test_same_keychain_key_is_verified_without_update():
    store=Store(KEY);result=module.save_key('coverr',KEY,environment={},store=store)
    assert result['verified'] and not result['saved'] and len(store.reads)==1 and not store.adds

@pytest.mark.parametrize('previous',[b'another-synthetic-key',b'',b'\xff'])
def test_keychain_conflict_keeps_original(previous):
    store=Store(previous)
    with pytest.raises(module.StockCredentialError) as failure:module.save_key('coverr',KEY,environment={},store=store)
    assert failure.value.code=='keychain_conflict' and not store.adds and store.value==previous

@pytest.mark.parametrize('same',[True,False])
def test_service_only_legacy_account_cannot_be_duplicated_or_hide_a_different_key(same):
    class Legacy(Store):
        def read_service(self,service):return KEY if same else b'other-legacy-synthetic'
    store=Legacy()
    if same:
        result=module.save_key('pexels',KEY,environment={},store=store)
        assert result['verified'] and not result['saved']
    else:
        with pytest.raises(module.StockCredentialError) as failure:module.save_key('pexels',KEY,environment={},store=store)
        assert failure.value.code=='keychain_conflict'
    assert not store.adds

def test_new_item_also_verifies_service_only_startup_lookup():
    class Ambiguous(Store):
        def read_service(self,service):return None if self.value is None else b'wrong-startup-synthetic'
    store=Ambiguous()
    with pytest.raises(module.StockCredentialError) as failure:module.save_key('pexels',KEY,environment={},store=store)
    assert failure.value.code=='verification_failed' and len(store.adds)==1 and store.value==KEY

def test_matching_account_cannot_claim_verified_when_startup_matches_another_item():
    class Ambiguous(Store):
        def read_service(self,service):return b'wrong-legacy-startup-synthetic'
    store=Ambiguous(KEY)
    with pytest.raises(module.StockCredentialError) as failure:module.save_key('pexels',KEY,environment={},store=store)
    assert failure.value.code=='keychain_conflict' and not store.adds and store.value==KEY

@pytest.mark.parametrize('same',[True,False])
def test_duplicate_race_only_reads_again_and_never_updates(same):
    class Race(Store):
        def add(self,*a):
            self.adds.append(a[:2]);self.value=KEY if same else b'another-synthetic-race-key'
            raise module.StockCredentialError('keychain_duplicate')
    store=Race()
    if same:assert module.save_key('pexels',KEY,environment={},store=store)['saved'] is False
    else:
        with pytest.raises(module.StockCredentialError) as failure:module.save_key('pexels',KEY,environment={},store=store)
        assert failure.value.code=='keychain_conflict'
    assert len(store.adds)==1 and len(store.reads)==2

@pytest.mark.parametrize('returned',[None,b'wrong-readback'])
def test_failed_readback_never_claims_verified_or_deletes_saved_key(returned):
    class WrongRead(Store):
        def read(self,*a): self.reads.append(a);return None if len(self.reads)==1 else returned
    store=WrongRead()
    with pytest.raises(module.StockCredentialError) as failure:module.save_key('pexels',KEY,environment={},store=store)
    assert failure.value.code=='verification_failed' and store.value==KEY and len(store.adds)==1

@pytest.mark.parametrize('phase',['read','add'])
def test_api_exceptions_are_fixed_and_never_echo_the_key(phase):
    store=Store()
    def fail(*a):raise RuntimeError(KEY.decode())
    setattr(store,phase,fail)
    with pytest.raises(module.StockCredentialError) as failure:module.save_key('pexels',KEY,environment={},store=store)
    assert failure.value.code=='keychain_error' and KEY.decode() not in str(failure.value)

def test_non_macos_has_no_storage_or_provider_fallback(monkeypatch):
    monkeypatch.setattr(module.sys,'platform','linux')
    with pytest.raises(module.StockCredentialError) as failure:module.save_key('pexels',KEY,environment={'OPENAI_API_KEY':'unrelated-synthetic'})
    assert failure.value.code=='platform_unavailable'

class Fn:
    def __init__(self,fn):self.fn=fn
    def __call__(self,*args):return self.fn(*args)

def framework(monkeypatch,*,interaction_status=0,find_status=0,add_status=0):
    calls=[];allocation=ctypes.create_string_buffer(KEY)
    def find(keychain,slen,s,alen,a,length,data,item):
        calls.append(('find',s,a))
        if find_status==0:
            ctypes.cast(length,ctypes.POINTER(ctypes.c_uint32))[0]=len(KEY)
            ctypes.cast(data,ctypes.POINTER(ctypes.c_void_p))[0]=ctypes.addressof(allocation)
        return find_status
    def add(keychain,slen,s,alen,a,klen,key,item):calls.append(('add',s,a,klen));return add_status
    lib=types.SimpleNamespace(SecKeychainFindGenericPassword=Fn(find),SecKeychainAddGenericPassword=Fn(add),
        SecKeychainItemFreeContent=Fn(lambda *a:calls.append(('free',)) or 0),
        SecKeychainSetUserInteractionAllowed=Fn(lambda allowed:calls.append(('interaction',allowed)) or interaction_status))
    monkeypatch.setattr(module.sys,'platform','darwin');monkeypatch.setattr(module.ctypes,'CDLL',lambda _:lib)
    return lib,calls

def test_framework_noninteractive_exact_service_and_memory_free(monkeypatch):
    lib,calls=framework(monkeypatch)
    store=module.MacOSStockKeychain()
    assert calls==[('interaction',False)]
    assert store.read('PEXELS_API_KEY',module.KEYCHAIN_ACCOUNT)==KEY
    assert calls[-1]==('free',) and calls[-2]==('find',b'PEXELS_API_KEY',b'zhejiang-tourism-stock')
    store.add('PIXABAY_API_KEY',module.KEYCHAIN_ACCOUNT,KEY)
    assert calls[-1]==('add',b'PIXABAY_API_KEY',b'zhejiang-tourism-stock',len(KEY))

@pytest.mark.parametrize('status',[-25308,-25293,1])
def test_framework_denied_reads_do_not_prompt_or_fallback(monkeypatch,status):
    _,calls=framework(monkeypatch,find_status=status)
    store=module.MacOSStockKeychain()
    with pytest.raises(module.StockCredentialError):store.read('PEXELS_API_KEY',module.KEYCHAIN_ACCOUNT)
    assert calls==[('interaction',False),('find',b'PEXELS_API_KEY',b'zhejiang-tourism-stock')]

def test_framework_not_found_is_distinct_from_access_error(monkeypatch):
    _,calls=framework(monkeypatch,find_status=-25300)
    assert module.MacOSStockKeychain().read('COVERR_API_KEY',module.KEYCHAIN_ACCOUNT) is None
    assert len(calls)==2

@pytest.mark.parametrize('status,code',[(-25299,'keychain_duplicate'),(-25308,'keychain_error')])
def test_framework_add_error_is_not_update(monkeypatch,status,code):
    _,calls=framework(monkeypatch,add_status=status)
    with pytest.raises(module.StockCredentialError) as failure:module.MacOSStockKeychain().add('COVERR_API_KEY',module.KEYCHAIN_ACCOUNT,KEY)
    assert failure.value.code==code and calls==[('interaction',False),('add',b'COVERR_API_KEY',b'zhejiang-tourism-stock',len(KEY))]

def test_disabling_gui_failure_stops_before_any_access(monkeypatch):
    _,calls=framework(monkeypatch,interaction_status=-1)
    with pytest.raises(module.StockCredentialError):module.MacOSStockKeychain()
    assert calls==[('interaction',False)]

def run_cli(data,argv=None,**kwargs):
    output=io.StringIO();store=Store()
    writer=kwargs.pop('writer',lambda provider,key:module.save_key(provider,key,environment={},store=store))
    status=cli.main(argv or ['--provider','pexels','--stdin'],stdin=io.BytesIO(data),output=output,writer=writer,**kwargs)
    return status,json.loads(output.getvalue()),store,output.getvalue()

def test_cli_stdin_success_prints_safe_metadata_only():
    status,receipt,store,raw=run_cli(KEY)
    assert status==0 and receipt=={'ok':True,'provider':'pexels','service':'PEXELS_API_KEY','configured':True,'saved':True,'verified':True}
    assert KEY.decode() not in raw and store.value==KEY

@pytest.mark.parametrize('data',[b'',b'key with space',KEY+b'\n',b'x'*2049])
def test_cli_empty_whitespace_bounds_never_write(data):
    status,receipt,store,raw=run_cli(data)
    assert status==2 and not receipt['ok'] and not store.adds

def test_cli_rejects_key_argv_without_echoing_its_value():
    status,receipt,store,raw=run_cli(b'',argv=['--provider','pexels','--key',KEY.decode()])
    assert status==2 and not receipt['ok'] and KEY.decode() not in raw and not store.adds

def test_cli_provider_argument_failure_does_not_echo_arbitrary_value():
    status,receipt,store,raw=run_cli(b'',argv=['--provider',KEY.decode(),'--stdin'])
    assert status==2 and not receipt['ok'] and KEY.decode() not in raw

@pytest.mark.parametrize('changed',[{'verified':False},{'verified':'true'},{'saved':'yes'},{'service':KEY.decode()}])
def test_cli_unverified_or_unsafe_receipt_never_claims_success(changed):
    result={'provider':'pexels','service':'PEXELS_API_KEY','configured':True,'verified':True,'saved':True,**changed}
    status,receipt,store,raw=run_cli(KEY,writer=lambda *a:result)
    assert status==4 and not receipt['ok'] and KEY.decode() not in raw

def test_getpass_hidden_prompt_and_warning_never_echo_or_save():
    status,receipt,store,raw=run_cli(b'',argv=['--provider','coverr'],prompt=lambda _:KEY.decode())
    assert status==0 and receipt['service']=='COVERR_API_KEY' and KEY.decode() not in raw
    def unsafe(_):
        import warnings,getpass
        warnings.warn('synthetic getpass failure',getpass.GetPassWarning)
        pytest.fail('must stop before echoed fallback input')
    status,receipt,store,raw=run_cli(b'',argv=['--provider','coverr'],prompt=unsafe)
    assert status==4 and not receipt['ok'] and not store.adds

def test_adapter_bootstrap_adds_only_same_name_stock_services():
    import ast
    source=Path(__file__).resolve().parents[2]/'backlot/model_adapter.py'
    tree=ast.parse(source.read_text())
    app=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='create_app')
    calls=[{keyword.arg:ast.literal_eval(keyword.value) for keyword in node.keywords} for node in app.body
        if isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name)
        and node.value.func.id=='_load_macos_keychain_secret' for node in [node.value]]
    assert calls[:3]==[{'service':name,'environment_name':name} for name in ['ARK_API_KEY','DOUBAO_SPEECH_API_KEY','ELEVENLABS_API_KEY']]
    assert calls[3:]==[{'service':name,'environment_name':name} for name in ['PEXELS_API_KEY','PIXABAY_API_KEY','COVERR_API_KEY']]
