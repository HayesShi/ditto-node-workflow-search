import json
import unittest
import httpx
from openai import AsyncOpenAI
from provider_bridge import complete
from repeated_output import repeated_output, RepetitionGuard, DegenerateOutputError


class CycleTests(unittest.TestCase):
    def test_exact_cycles_and_progress(self):
        self.assertFalse(repeated_output('x' * 8192))
        self.assertTrue(repeated_output('x' * 8193))
        self.assertTrue(repeated_output(('abcdef' * 3000)))
        self.assertFalse(repeated_output(''.join(f'computation step {i}: {i*i};' for i in range(3000))))

    def test_utf16_and_channel_isolation(self):
        guard = RepetitionGuard()
        guard.feed('text_delta', '😀' * 2048)
        guard.feed('reasoning_delta', '😀' * 2048)
        self.assertEqual(guard.channels['text_delta']['chars'], 4096)
        guard.feed('text_delta', '😀' * 2048)
        with self.assertRaises(DegenerateOutputError):
            guard.feed('text_delta', '😀' * 2048)


class BridgeCycleTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, handler):
        records = []
        async with AsyncOpenAI(api_key='fixture',base_url='https://fixture.invalid',max_retries=0,
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as client:
            result = await complete(client,{'id':1,'body':{'model':'fixture','messages':[]}},5000,records.append)
        return result, records

    async def test_repetition_terminal_no_retry_unknown_usage(self):
        requests=[]
        def handler(request):
            requests.append(request)
            events=[{'choices':[{'index':0,'delta':{'content':'abc'*1400}}]} for _ in range(8)]
            body=''.join('data: '+json.dumps(e)+'\n\n' for e in events)
            return httpx.Response(200,headers={'content-type':'text/event-stream'},text=body)
        result, records=await self.invoke(handler)
        self.assertEqual(len(requests),1)
        self.assertEqual(result['status'],422)
        self.assertEqual(result['body']['error']['code'],'DEGENERATE_OUTPUT')
        self.assertEqual(result['body']['error']['source'],'model-output')
        self.assertFalse(result['diagnostics']['usageKnown'])
        self.assertLess(len(records[-1]['partialResponse']['choices'][0]['message']['content']),33600)

    async def test_context_provenance_does_not_classify_every_400(self):
        for code,message,source in [('invalid_request_error','maximum context length exceeded','model-output'),
                                    ('invalid_request_error','unsupported parameter','provider'),
                                    ('context_length_exceeded','too long','model-output')]:
            result,_=await self.invoke(lambda request:httpx.Response(400,json={'error':{'code':code,'message':message}}))
            self.assertEqual(result['body']['error']['source'],source)
            self.assertEqual(result['diagnostics']['attempts'],1)


if __name__=='__main__':
    unittest.main()
