const template = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  creationTimestamp: null
  name: new-ingress
  namespace: default
spec:
  rules:
  - host: foo.com
    http:
      paths:
      - backend:
          service:
            name: svc1
            port:
              number: 8080
        path: /bar
        pathType: Exact
`;

export default template;
