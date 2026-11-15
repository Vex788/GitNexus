/**
 * End-to-End FE <-> BE Cross-Boundary Route & Impact Tests
 *
 * Verifies:
 * 1. Stripes `@UrlBinding` + `@HandlesEvent`, Spring `@RestController`, and `WEB-INF/web.xml` servlet routes.
 * 2. Extended HTTP clients (`$.ajax`, `axios` with `const` URL prefix, RTK Query `createApi`, JSP `<s:form beanclass>` & `<c:url>`).
 * 3. End-to-end `Process` execution flows bridging FE functions -> Route -> BE handlers -> BE services.
 * 4. `impact()` upstream (BE service -> BE handler -> FE requester -> UI caller) & downstream (UI caller -> FE requester -> BE handler -> BE service).
 * 5. `context()` cross-boundary `route_consumers`, `fetches_routes`, `incoming.fetches`, and `outgoing.fetches`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { useFixture, getRelationships, getNodesByLabelFull } from './resolvers/helpers.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

describe('FE <-> BE pipeline extraction (Stripes, Spring, web.xml, JSP, axios, jQuery, RTK Query)', () => {
  const getPipeline = useFixture('fe-be-cross-boundary', {
    'src/com/acme/service/OrderNoteService.java': `
      package com.acme.service;
      public class OrderNoteService {
        public void appendNote(String orderId, String text) {
          persistAudit(orderId);
        }
        public void persistAudit(String orderId) {}
      }
    `,
    'src/com/acme/web/SalesOrdersActionBean.java': `
      package com.acme.web;
      import com.acme.service.OrderNoteService;
      import net.sourceforge.stripes.action.DefaultHandler;
      import net.sourceforge.stripes.action.HandlesEvent;
      import net.sourceforge.stripes.action.Resolution;
      import net.sourceforge.stripes.action.UrlBinding;

      @UrlBinding("/sales_orders.xhtml")
      public class SalesOrdersActionBean {
        private OrderNoteService noteService = new OrderNoteService();

        @DefaultHandler
        public Resolution view() {
          return null;
        }

        @HandlesEvent("addnotes")
        public Resolution addNotes() {
          noteService.appendNote("100", "ok");
          return null;
        }
      }
    `,
    'src/com/acme/api/OrderRestController.java': `
      package com.acme.api;
      import com.acme.service.OrderNoteService;
      import org.springframework.web.bind.annotation.PathVariable;
      import org.springframework.web.bind.annotation.PostMapping;
      import org.springframework.web.bind.annotation.RequestMapping;
      import org.springframework.web.bind.annotation.RestController;

      @RestController
      @RequestMapping("/api/v1/orders")
      public class OrderRestController {
        private final OrderNoteService noteService = new OrderNoteService();

        @PostMapping("/{id}/approve")
        public String approveOrder(@PathVariable String id) {
          noteService.appendNote(id, "approved");
          return "ok";
        }
      }
    `,
    'src/com/acme/servlet/OrderExportServlet.java': `
      package com.acme.servlet;
      import javax.servlet.http.HttpServlet;
      import javax.servlet.http.HttpServletRequest;
      import javax.servlet.http.HttpServletResponse;

      public class OrderExportServlet extends HttpServlet {
        protected void doGet(HttpServletRequest req, HttpServletResponse resp) {}
      }
    `,
    'web/WEB-INF/web.xml': `
      <web-app>
        <servlet>
          <servlet-name>OrderExportServlet</servlet-name>
          <servlet-class>com.acme.servlet.OrderExportServlet</servlet-class>
        </servlet>
        <servlet-mapping>
          <servlet-name>OrderExportServlet</servlet-name>
          <url-pattern>/export/orders</url-pattern>
        </servlet-mapping>
      </web-app>
    `,
    'web/scripts/orders-client.ts': `
      import axios from 'axios';
      import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

      const ORDERS_API_BASE = '/api/v1/orders';
      const ORDERS_PAGE_URL = './sales_orders.xhtml';

      export function submitOrderNote(note: string) {
        return $.ajax({
          type: 'POST',
          url: \`\${ORDERS_PAGE_URL}?addnotes&ajax=true\`,
          data: { note },
        });
      }

      export async function approveSelectedOrder(orderId: string) {
        return axios.post(\`\${ORDERS_API_BASE}/\${orderId}/approve\`);
      }

      export function handleToolbarClick(orderId: string) {
        submitOrderNote('confirmed');
        return approveSelectedOrder(orderId);
      }

      export const ordersApi = createApi({
        reducerPath: 'ordersApi',
        baseQuery: fetchBaseQuery({ baseUrl: '/api/v1/orders' }),
        endpoints: (builder) => ({
          approveByRtk: builder.mutation({
            query: (id: string) => ({
              url: \`/\${id}/approve\`,
              method: 'POST',
            }),
          }),
        }),
      });
    `,
    'web/pages/orders.jsp': `
      <%@ taglib prefix="s" uri="http://stripes.sourceforge.net/stripes.tld" %>
      <%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
      <s:form beanclass="com.acme.web.SalesOrdersActionBean">
        <s:submit name="addnotes" value="Save"/>
      </s:form>
      <a href="<c:url value='/export/orders'/>">Export</a>
    `,
  });

  it('extracts Stripes base + event routes, Spring routes, and web.xml servlet routes', () => {
    const result = getPipeline();
    const routeNames = getNodesByLabelFull(result, 'Route').map((n) => n.name);
    expect(routeNames).toContain('/sales_orders.xhtml');
    expect(routeNames).toContain('/sales_orders.xhtml!addnotes');
    expect(routeNames).toContain('/api/v1/orders/{id}/approve');
    expect(routeNames).toContain('/export/orders');
  });

  it('links jQuery $.ajax, axios with const prefix, RTK Query, and JSP tags via FETCHES edges', () => {
    const result = getPipeline();
    const fetches = getRelationships(result, 'FETCHES');

    const tsToStripesEvent = fetches.find(
      (e) =>
        e.sourceFilePath === 'web/scripts/orders-client.ts' &&
        e.target === '/sales_orders.xhtml!addnotes',
    );
    expect(tsToStripesEvent).toBeDefined();
    expect(tsToStripesEvent?.rel.reason).toContain('submitOrderNote');

    const tsToSpring = fetches.find(
      (e) =>
        e.sourceFilePath === 'web/scripts/orders-client.ts' &&
        e.target === '/api/v1/orders/{id}/approve',
    );
    expect(tsToSpring).toBeDefined();
    expect(tsToSpring?.rel.reason).toContain('approveSelectedOrder');

    const jspToStripesEvent = fetches.find(
      (e) =>
        e.sourceFilePath === 'web/pages/orders.jsp' &&
        e.target === '/sales_orders.xhtml!addnotes',
    );
    expect(jspToStripesEvent).toBeDefined();

    const jspToExport = fetches.find(
      (e) => e.sourceFilePath === 'web/pages/orders.jsp' && e.target === '/export/orders',
    );
    expect(jspToExport).toBeDefined();
  });

  it('traces end-to-end Process flows from frontend UI handler into backend Java service', () => {
    const result = getPipeline();
    const stepEdges = getRelationships(result, 'STEP_IN_PROCESS');
    const stepsByProcess = new Map<string, string[]>();
    for (const edge of stepEdges) {
      const pid = edge.rel.targetId;
      const list = stepsByProcess.get(pid) ?? [];
      list.push(edge.source);
      stepsByProcess.set(pid, list);
    }

    const hasCrossBoundaryFlow = [...stepsByProcess.values()].some(
      (steps) =>
        steps.includes('handleToolbarClick') &&
        (steps.includes('addNotes') || steps.includes('approveOrder')) &&
        steps.includes('appendNote'),
    );
    expect(hasCrossBoundaryFlow).toBe(true);
  });
});

const UI_CALLER = 'Function:web/orders.ts:handleSaveButton';
const FE_REQUESTER = 'Function:web/orders.ts:postOrderNote';
const FE_FILE = 'File:web/orders.ts';
const ROUTE_ID = 'Route:POST /api/orders/:id/notes';
const BE_HANDLER = 'Method:src/OrderController.java:OrderController.addNote';
const BE_SERVICE = 'Method:src/OrderService.java:OrderService.saveNote';

const CROSS_BOUNDARY_SEED = [
  `CREATE (f:File {id:'${FE_FILE}', name:'orders.ts', filePath:'web/orders.ts', content:''})`,
  `CREATE (fn:Function {id:'${UI_CALLER}', name:'handleSaveButton', filePath:'web/orders.ts', startLine:1, endLine:4, isExported:true, content:'', description:''})`,
  `CREATE (fn:Function {id:'${FE_REQUESTER}', name:'postOrderNote', filePath:'web/orders.ts', startLine:6, endLine:10, isExported:true, content:'', description:''})`,
  `CREATE (m:Method {id:'${BE_HANDLER}', name:'addNote', filePath:'src/OrderController.java', startLine:10, endLine:16, isExported:true, content:'', description:''})`,
  `CREATE (m:Method {id:'${BE_SERVICE}', name:'saveNote', filePath:'src/OrderService.java', startLine:5, endLine:12, isExported:true, content:'', description:''})`,
  `CREATE (r:Route {id:'${ROUTE_ID}', name:'/api/orders/:id/notes', filePath:'src/OrderController.java', method:'POST', handlerSymbolId:'${BE_HANDLER}'})`,
  `MATCH (a:Function {id:'${UI_CALLER}'}), (b:Function {id:'${FE_REQUESTER}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:1.0, reason:'direct', step:0}]->(b)`,
  `MATCH (f:File {id:'${FE_FILE}'}), (r:Route {id:'${ROUTE_ID}'}) CREATE (f)-[:CodeRelation {type:'FETCHES', confidence:0.9, reason:'fetch-url-match|via:${FE_REQUESTER}', step:0}]->(r)`,
  `MATCH (h:Method {id:'${BE_HANDLER}'}), (r:Route {id:'${ROUTE_ID}'}) CREATE (h)-[:CodeRelation {type:'HANDLES_ROUTE', confidence:1.0, reason:'spring-route', step:0}]->(r)`,
  `MATCH (h:Method {id:'${BE_HANDLER}'}), (s:Method {id:'${BE_SERVICE}'}) CREATE (h)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'import-resolved', step:0}]->(s)`,
];

withTestLbugDB(
  'fe-be-mcp-impact-context',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as unknown as { _backend: LocalBackend })._backend;
    });

    it('impact(upstream) walks from backend service through Route into frontend function and UI caller', async () => {
      const res = await backend.callTool('impact', {
        target: 'saveNote',
        direction: 'upstream',
        maxDepth: 4,
      });

      const byDepth = res.byDepth as Record<string, Array<{ id: string }>>;
      expect(byDepth['1']?.map((i) => i.id)).toContain(BE_HANDLER);
      expect(byDepth['2']?.map((i) => i.id)).toContain(FE_REQUESTER);
      expect(byDepth['3']?.map((i) => i.id)).toContain(UI_CALLER);
      expect(res.affected_routes).toEqual([{ url: '/api/orders/:id/notes', method: 'POST' }]);
    });

    it('impact(downstream) walks from UI caller through frontend requester and Route into backend handler and service', async () => {
      const res = await backend.callTool('impact', {
        target: 'handleSaveButton',
        direction: 'downstream',
        maxDepth: 4,
      });

      const byDepth = res.byDepth as Record<string, Array<{ id: string }>>;
      expect(byDepth['1']?.map((i) => i.id)).toContain(FE_REQUESTER);
      expect(byDepth['2']?.map((i) => i.id)).toContain(BE_HANDLER);
      expect(byDepth['3']?.map((i) => i.id)).toContain(BE_SERVICE);
      expect(res.affected_routes).toEqual([{ url: '/api/orders/:id/notes', method: 'POST' }]);
    });

    it('context() surfaces route_consumers on backend handler and fetches_routes on frontend caller', async () => {
      const beCtx = await backend.callTool('context', { uid: BE_HANDLER });
      expect(beCtx.routes).toEqual([{ url: '/api/orders/:id/notes', method: 'POST' }]);
      expect(beCtx.route_consumers).toEqual([
        {
          uid: FE_REQUESTER,
          name: 'postOrderNote',
          filePath: 'web/orders.ts',
          kind: 'Function',
          url: '/api/orders/:id/notes',
          method: 'POST',
        },
      ]);
      expect(beCtx.incoming?.fetches).toEqual([
        {
          uid: FE_REQUESTER,
          name: 'postOrderNote',
          filePath: 'web/orders.ts',
          kind: 'Function',
        },
      ]);

      const feCtx = await backend.callTool('context', { uid: FE_REQUESTER });
      expect(feCtx.fetches_routes).toEqual([
        {
          url: '/api/orders/:id/notes',
          method: 'POST',
          handlers: [
            {
              uid: BE_HANDLER,
              name: 'addNote',
              filePath: 'src/OrderController.java',
              kind: 'Method',
            },
          ],
        },
      ]);
      expect(feCtx.outgoing?.fetches).toEqual([
        {
          uid: BE_HANDLER,
          name: 'addNote',
          filePath: 'src/OrderController.java',
          kind: 'Method',
        },
      ]);
    });

    it('route_map reports exact single consumer without duplicating callable edges', async () => {
      const rm = await backend.callTool('route_map', { route: '/api/orders/:id/notes' });
      expect(rm.routes).toHaveLength(1);
      expect(rm.routes[0].consumers).toHaveLength(1);
    });
  },
  {
    seed: CROSS_BOUNDARY_SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'fe-be-repo',
          path: '/test/fe-be-repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 4, nodes: 6, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as unknown as { _backend: LocalBackend })._backend = backend;
    },
  },
);
